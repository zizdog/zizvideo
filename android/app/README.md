# zizvideo 安卓客户端（android/）

**定位**：薄壳 —— 登录/浏览/管理全部复用 zizvideo 现成的网页界面，只有"网页给不了"的部分用原生：
后台播放（听视频）、硬件解码、锁屏/通知栏控制。

## 现状（分步交付）
- [x] 原生首屏：服务器地址 + 用户名 + 口令（探活用公开的 `/api/v1/setup/status`，登录用 `/api/v1/auth/login`），
      会话 cookie 灌进 WebView 的 CookieManager ⇒ 重启免登录（口令不落盘）。
- [x] WebView 宿主：返回键走网页历史、网页全屏视频、文件选择（后台"上传"要用）、外链走系统浏览器、
      自签 HTTPS 证书让用户自己决定。
- [ ] 原生播放页：ExoPlayer（MediaCodec 硬解）+ `MediaSessionService` 前台服务 ⇒ 后台/锁屏听视频。

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
