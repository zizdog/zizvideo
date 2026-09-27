plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

import java.util.Properties

// 发布签名：keystore.properties（gitignored，本机密钥库在仓库外）。没有这个文件就只出 debug 包。
// 注意：KTS 里 `java.` 会被解析成 java 插件扩展，必须 import java.util.Properties。
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "com.zizdog.zizvideo"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.zizdog.zizvideo"
        minSdk = 24
        targetSdk = 35
        versionCode = 37
        versionName = "0.4.0"
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // 自用发布：正式签名（换包不用卸载重装）；不混淆，省得跟反射/媒体库打架。
            isMinifyEnabled = false
            // ⚠️ 关掉 PNG 压缩：AGP 会把图**缩小**（实测 432 的自适应前景 → 128、512 的登录图 → 72，
            // 图标直接糊）。图标/logo 这点体积不值得换清晰度（用户 2026-09-25 这轮踩到）。
            isCrunchPngs = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    // 原生播放：MediaCodec 硬解 + MediaSession（锁屏/通知栏/耳机键）+ 前台服务（后台不被回收）
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    implementation("androidx.media3:media3-ui:1.4.1")
    implementation("androidx.media3:media3-session:1.4.1")
    // 扫码登录（用户 2026-09-27）：手机 App 里直接开相机扫电视上的二维码。
    // CameraX 负责预览/取帧，ZXing core 负责解二维码（纯 Java，没有原生库）。
    implementation("androidx.camera:camera-core:1.3.4")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.zxing:core:3.5.3")
    testImplementation("junit:junit:4.13.2")
}
