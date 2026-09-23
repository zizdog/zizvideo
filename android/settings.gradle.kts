// zizvideo 安卓客户端：只做薄壳（原生登录 + 复用网页 UI）+ 原生播放页（见 README）。
// 国内构建走阿里云镜像（google/mavenCentral/gradle-plugin 三处），否则依赖会卡到超时。
pluginManagement {
    repositories {
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
    repositories {
        maven("https://maven.aliyun.com/repository/google")
        maven("https://maven.aliyun.com/repository/public")
        google()
        mavenCentral()
    }
}
rootProject.name = "zizvideo"
include(":app")
