# 本机构建环境（一次性装好的工具链，别写进 git 之外的机器上）
#   JDK 17 / Gradle 8.9：~/android-toolchain（清华 + 腾讯镜像下的，没用 brew）
#   Android SDK：~/Library/Android/sdk（cmdline-tools + platform-tools + android-35 + build-tools 35）
export JAVA_HOME=/Users/zizdog/android-toolchain/jdk-17.0.20.1+1/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$JAVA_HOME/bin:$HOME/android-toolchain/gradle-8.9/bin:$ANDROID_HOME/platform-tools:$PATH"
