# zizvideo 安卓客户端（android/）

**定位**：薄壳 —— 登录/浏览/管理全部复用 zizvideo 现成的网页界面，只有"网页给不了"的部分用原生：
后台播放（听视频）、硬件解码、锁屏/通知栏控制。

## 现状（分步交付）
- [x] 原生首屏：服务器地址 + 用户名 + 口令（探活用公开的 `/api/v1/setup/status`，登录用 `/api/v1/auth/login`），
      会话 cookie 灌进 WebView 的 CookieManager ⇒ 重启免登录（口令不落盘）。
- [x] WebView 宿主：返回键走网页历史、网页全屏视频、文件选择（后台"上传"要用）、外链走系统浏览器、
      自签 HTTPS 证书让用户自己决定。
- [ ] 原生播放页：ExoPlayer（MediaCodec 硬解）+ `MediaSessionService` 前台服务 ⇒ 后台/锁屏听视频。

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
