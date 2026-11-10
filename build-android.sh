#!/bin/sh
# 独立版安卓包构建（在装有 JDK21 + Android SDK + Gradle 的机器上跑，InstaBox 免费机即可）
# 用法：sh build-android.sh [工程目录] [debug|release]    缺省 ~/build-standalone + debug
# release 需要签名配置：环境变量 KEYSTORE_PROPS 指向 keystore.properties（缺省 ~/signing/keystore.properties）
set -e
DIR="${1:-$HOME/build-standalone}"
FLAVOR="${2:-debug}"
cd "$DIR"
[ -d node_modules ] || npm install
[ -d android ] || npx cap add android
npx cap sync
# 覆盖件（cap add/sync 会重新生成，必须之后再盖）：主题（退贴边）+ 图标全套
cp android-overrides/styles.xml android/app/src/main/res/values/styles.xml
cp -r android-overrides/res/mipmap-* android/app/src/main/res/
cp android-overrides/res/values/ic_launcher_background.xml android/app/src/main/res/values/ic_launcher_background.xml
# 语音输入需要录音权限（cap 生成的清单里没有，补上；幂等）
MANIFEST=android/app/src/main/AndroidManifest.xml
grep -q "RECORD_AUDIO" "$MANIFEST" || sed -i 's#</manifest>#    <uses-permission android:name="android.permission.RECORD_AUDIO" />\n</manifest>#' "$MANIFEST"
echo "sdk.dir=$HOME/android-sdk" > android/local.properties
if [ "$FLAVOR" = "release" ]; then
  PROPS="${KEYSTORE_PROPS:-$HOME/signing/keystore.properties}"
  [ -f "$PROPS" ] || { echo "缺签名配置 $PROPS，先生成 keystore"; exit 1; }
  cp "$PROPS" android/keystore.properties
  python3 android-overrides/patch_release.py android/app/build.gradle
  # 版本号可用环境变量覆盖（已打补丁的工程靠这两行升版）
  [ -n "$VERSION_NAME" ] && sed -i "s/versionName \"[^\"]*\"/versionName \"$VERSION_NAME\"/" android/app/build.gradle
  [ -n "$VERSION_CODE" ] && sed -i "s/versionCode [0-9]*/versionCode $VERSION_CODE/" android/app/build.gradle
  ANDROID_HOME="$HOME/android-sdk" "$HOME/gradle-8.11.1/bin/gradle" -p android assembleRelease --no-daemon
  echo "产物：$DIR/android/app/build/outputs/apk/release/app-release.apk"
else
  ANDROID_HOME="$HOME/android-sdk" "$HOME/gradle-8.11.1/bin/gradle" -p android assembleDebug --no-daemon
  echo "产物：$DIR/android/app/build/outputs/apk/debug/app-debug.apk"
fi
