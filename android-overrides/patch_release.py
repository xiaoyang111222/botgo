#!/usr/bin/env python3
# 给 Capacitor 模板的 app/build.gradle 打 release 签名补丁（幂等：打过就跳过）。
# 用法：python3 patch_release.py <build.gradle 路径>
# 依赖：android/keystore.properties（storeFile/storePassword/keyAlias/keyPassword），构建时由 build-android.sh 放好。
import sys

path = sys.argv[1]
text = open(path, encoding='utf-8').read()
if 'signingConfigs' in text:
    print('已打过补丁，跳过')
    sys.exit(0)

loader = """apply plugin: 'com.android.application'

// 签名配置（keystore.properties 存在时启用 release 签名）
def keystoreProps = new Properties()
def keystorePropsFile = rootProject.file('keystore.properties')
if (keystorePropsFile.exists()) { keystoreProps.load(new FileInputStream(keystorePropsFile)) }
"""
text = text.replace("apply plugin: 'com.android.application'\n", loader, 1)

signing = """    signingConfigs {
        release {
            if (keystorePropsFile.exists()) {
                storeFile file(keystoreProps['storeFile'])
                storePassword keystoreProps['storePassword']
                keyAlias keystoreProps['keyAlias']
                keyPassword keystoreProps['keyPassword']
            }
        }
    }
    buildTypes {"""
assert '    buildTypes {' in text
text = text.replace('    buildTypes {', signing, 1)

anchor = '        release {\n            minifyEnabled false'
assert anchor in text
text = text.replace(anchor, '        release {\n            signingConfig signingConfigs.release\n            minifyEnabled false', 1)

text = text.replace('versionCode 1', 'versionCode 11')
text = text.replace('versionName "1.0"', 'versionName "1.2.0"')
open(path, 'w', encoding='utf-8').write(text)
print('release 签名补丁已应用：', path)
