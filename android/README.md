# zizvideo 安卓客户端（android/）

**定位**：薄壳 —— 登录/浏览/管理全部复用 zizvideo 现成的网页界面，只有"网页给不了"的部分用原生：
后台播放（听视频）、硬件解码、锁屏/通知栏控制。

## 现状（分步交付）
- [x] 原生首屏：服务器地址 + 用户名 + 口令（探活用公开的 `/api/v1/setup/status`，登录用 `/api/v1/auth/login`），
      会话 cookie 灌进 WebView 的 CookieManager ⇒ 重启免登录（口令不落盘）。
- [x] WebView 宿主：返回键走网页历史、网页全屏视频、文件选择（后台"上传"要用）、外链走系统浏览器、
      自签 HTTPS 证书让用户自己决定。
- [x] 原生播放页：ExoPlayer（MediaCodec 硬解）+ `MediaSessionService` 前台服务 ⇒ 后台/锁屏听视频（第二轮）。

## 播放架构（第二轮）
**网页负责"逛"和"管"，原生负责"放"和"后台"** —— 两者不重复实现：
- 网页里点「收藏/历史/稍后再看」的卡片 → 深链 `#/play/<kind>/<id>` → 安卓侧在
  `doUpdateVisitedHistory` 截住（同文档 hash 跳转**不会**走 `shouldOverrideUrlLoading`），
  交给 `PlayerActivity`；同时让网页退回列表页，避免网页播放器在后台跟原生两路声音。
- `PlaybackService`（`MediaSessionService`）：ExoPlayer 走 MediaCodec（硬解）+ 音频焦点 + `setWakeMode`；
  MediaSession 白送通知栏/锁屏控制与耳机按键；前台服务类型 `mediaPlayback`（`types=0x2`）。
- **播放器的 HTTP 不共享 WebView 的 cookie 罐**：`DefaultHttpDataSource.Factory()`
  显式 `setDefaultRequestProperties(Cookie)`，否则流 401。
- 进度按网页端同一个 `PATCH /api/v1/me/progress/{id}` 回写（5 秒一次 + 换条时），
  **必须在后台线程发**（第一版写在主线程，`NetworkOnMainThreadException` 把 service 崩了）。
- `search` 的队列是网页里的临时缓存，原生侧重建不了 ⇒ 不拦截，仍由网页播放器播（已知取舍）。
- 首页 `#/feed` 目前**仍是网页播放器内联播放**（后台不听）；要不要改成原生接管等用户定。

## 已验证（2026-09-23，模拟器 Pixel 6 / Android 15 / arm64）
`bash tools/emu-smoke.sh 10.0.2.2:17771 admin <口令>` 全绿：
原生登录页渲染正确 → 点登录进 `WebActivity` → 网页首页在**播放**（时间码在走）→
顶栏返回/搜索、右侧图标栏、底栏都在 →「我的」→ 安卓返回键回到首页（**不是退出 App**），
到底再按才退出。**还没验的**：真机硬件解码、后台/锁屏播放（那是原生播放页那一步的事）。

### 后台播放实测（第二轮）
点「收藏」里的卡片 → 原生播放页（`PlayerActivity`）→ 按 HOME 回桌面：
`dumpsys media_session` 里 `state=PLAYING(3)`，**12 秒里 position 走了 10,984ms**（后台确实在解码播放）；
`dumpsys activity services` 里 `isForeground=true types=0x00000002`（mediaPlayback 前台服务）；
通知栏有媒体通知（标题/暂停/进度条/上下一条）；锁屏后仍是 `PLAYING`。

## 后台播放：网页 ⇄ 原生 交接（第五轮，解决"App 还不如浏览器"）
**现象**：网页端在 Chrome 里能后台播，装进 WebView 壳就一退后台就断。
**根因**（实测，用网页播放器自己的进度心跳当判据）：Chromium 会**挂起隐藏且没有 MediaSession 的页面媒体** ——
前台 29518 → 按 HOME +15s 33802（还涨了 4 秒）→ 再 15 秒仍是 33802（停了）。Chrome 之所以能后台放，
是因为它替页面建了 MediaSession + 前台服务；WebView 没有这层。

**做法**（网页仓库、服务端都不用改）：注入一段钩子 + 一个 JS 桥，
`visibilitychange`（退后台/锁屏）且**真的在播**时，把**网页自己那份队列**（DOM 里所有播放壳的
media id 与标题、按顺序）+ 正在播的那条 + 位置整体交给原生播放服务：

```
网页(前台: 全 UI/按钮/手势)  --退后台-->  原生 PlaybackService(MediaSession+前台服务+唤醒锁)
        ^                                                  |
        +----------- 回前台: 停原生、按交出去那条续播 <-------+
```
- 桥走**绑定**（bindService）不是 startService：后台启动服务受限，绑定不受限；前台服务提升由服务自己做。
- 队列必须**整份带过去**，不能让原生自己重新拉 `/feed/next`：那会重新翻一页，顺序和用户在网页里看到的对不上（踩过）。
- 回前台按"刚交出去的那条 id"恢复，并把位置**钳到本条时长内**（原生可能已经连播到下一条，位置会超）。

实测（模拟器 / release 包）：前台网页进度 5016 → 按 HOME 后原生 `PLAYING position=24154` →
后台 10 秒 `33164` 且服务器进度 31102 → 回前台网页 40159→50159（+10s）、原生 `NONE`（没有两路声音）。

## 第六轮：原生播放页补互动栏 + 修一个严重自造 bug
- **严重 bug（我上一轮造的）**：为了"退后台交接"我给 `PlaybackService` 覆盖了 `onBind` 返回自己的 binder ——
  这会把 media3 的 **MediaController 连接掐断**（`MediaSessionService` 就是靠 onBind 把控制器给播放页的）。
  表现：从列表点进播放页是**黑屏 + 没有标题 + 图标不上色**，而服务自己在后台放（所以一开始没被发现）。
  修法：**不覆盖 onBind**，改用单进程实例引用 `PlaybackService.instance`（单进程应用够用且更简单）。
- 顺带把**静默失败变成看得见**：控制器连接失败会在标题处明说"播放器没连上，退出去重进一次"并打日志
  （`adb logcat -s zvplayer`），不再是一片黑让人猜。
- **原生播放页补互动栏**：❤ 收藏 / 👍 喜欢 / 🕒 稍后再看（同一批接口：`/me/favorites/{id}`、
  `/api/v1/media/{id}/reactions`、`/me/watch-later/{id}`），状态从 `GET /api/v1/media/{id}` 读，
  点亮变强调色。实测：点喜欢 → `reaction=like`；点稍后再看 → `watch_later=true`（服务器状态为准）。

## 真机验收清单（只能人工做，命令都在下面）
```bash
# 1) 装正式签名包（比 debug 小、以后换包不用卸载）
ZV_APK=app/build/outputs/apk/release/app-release.apk bash tools/emu-smoke.sh <host:port> <用户> <口令>
adb install -r app/build/outputs/apk/release/app-release.apk

# 2) 硬解判据（播放中执行）：看 codec 名字
adb shell dumpsys media.metrics | tr ',' '\n' | grep -o "android.media.mediacodec.codec=[a-zA-Z0-9._-]*" | sort | uniq -c | sort -rn
#   c2.android.*            ⇒ **软解**
#   c2.qti.* / c2.mtk.* / c2.exynos.* / c2.samsung.* / OMX.<厂商>.*  ⇒ **硬件解码** ✔
#   （模拟器上必然是 c2.android.*：模拟器没有真硬件解码器，别拿模拟器当硬解证据）

# 3) 后台/锁屏：播放中按 HOME、再锁屏，通知栏应有媒体控制且声音不断
#    控制也可以用按键路径验（等价耳机线控）：
#      adb shell input keyevent 127   # 暂停 → dumpsys media_session 应变成 state=PAUSED(2)
#      adb shell input keyevent 126   # 播放 → 变回 PLAYING(3)
#      adb shell input keyevent 87    # 下一集
#    后台稳不稳的硬证据（播放中执行，应看到 ExoPlayer 的 partial wakelock）：
#      adb shell dumpsys power | grep -i "ExoPlayer:WakeLockManager"
# 4) 国产 ROM：设置 → 电池/后台管理里给 zizvideo 允许后台运行（代码解决不了，必须手动放行）
```

## 第四轮新增
- **会话 cookie 现读**：服务原来只在 `onCreate` 缓存 cookie ⇒ 用户在网页里重新登录后原生播放器
  一直 401。改成数据源工厂 `createDataSource()` 时现读 + 进度上报现读。
- **登录态失效回原生登录页**：网页退到 `#/login` 时把用户交回 `LoginActivity`（重新登录会灌新 cookie），
  否则他会卡在"网页里登录了、原生还 401"这种半死状态。
- 验证（模拟器 / release 包）：耳机键暂停 `PLAYING(3)→PAUSED(2)`、播放 `PAUSED(2)→PLAYING(3)`；
  `dumpsys power` 里有 `10208 (com.zizdog.zizvideo) - ACQ ExoPlayer:WakeLockManager (partial)`
  ⇒ 后台解码靠的是 partial wakelock，不依赖亮屏。

## 第三轮新增
- **续播**：与网页端同语义（`position>0 且未看完`才续），标题会标「（已续播）」。
  实测：长样本 20199ms → 打开后 position 29148ms（= 20s + 播放 9s）。
- **正式签名**：`keystore.properties`（gitignored）+ 仓库外的 `~/android-toolchain/zv-release.keystore`，
  `assembleRelease` 出 7.6MB 签名包，`apksigner verify` 通过。**密钥丢了以后只能卸载重装才能升级。**
- **启动即打开指定页面**：`am start -n com.zizdog.zizvideo/.LoginActivity --es path "/#/favorites/later"`
  （通知/深链/自测都用它；自测不再写死导航栏坐标 —— 图标一改坐标就废，已经踩过一次）。
- 冒烟脚本：支持 `ZV_APK=` 换包（签名不同自动先卸载）、开机等网络、登录失败重试、
  后台判据改成"位置前进**或**已连播下一条"（5 秒短片会播完跳下一条，只比位置会误判）。

## 构建
需要 JDK 17 + Android SDK（cmdline-tools / platform-tools / platforms;android-35 / build-tools;35.0.0）。
```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_HOME=$HOME/Library/Android/sdk
./gradlew assembleDebug          # 产物：app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
依赖走阿里云镜像（`settings.gradle.kts`），国内不用镜像会卡到超时。

## 为什么不做"拦截网页 `<video>`"
网页播放器在锁屏后可能被冻结，连播/进度都会断；后台稳定要求播放队列归原生持有。
所以：**网页负责"逛"和"管"，原生负责"放"和"后台"**（详见仓库状态文档里的路线讨论）。
