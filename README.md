# 西柚答案助手（电脑版 + 安卓版）

面向“西柚英语”个人版的答案提取与模拟作答工具，包含两个独立工程：

| 目录 | 说明 |
|---|---|
| `XiyouAnswerHelperDesktop/` | 电脑版（Electron）。读取客户端本地缓存离线取答案，或账号登录在线取答案 |
| `XiyouAnswerHelperAndroid/` | 安卓版（原生 Java + 本地 WebView 界面）。账号登录 → 选作业 → 取答案 → 完整作答流程 |

## 功能

- 账号密码登录（电脑端 UA + `device=web-pc`，与网页端 4.8.6 同款请求签名）
- 按指定格式输出答案：每个大题取第一条答案，角色扮演拆成「三问 / 五答」，可切换详细模式（题干、全部答案、关键词、踩分点、原文）
- 安卓版作答：按服务器下发的 `processList` 复刻考试流程（播放题干/原文音频、视频、准备倒计时、录音作答），录音前有提示音，完成后把 WAV 语音包上传到西柚的 OSS 并确认送达
- 账号密码本地加密保存（桌面 DPAPI / 安卓 Keystore AES-GCM）

## 快速开始

### 电脑版

```
XiyouAnswerHelperDesktop\XiyouAnswerHelper.exe
```

或 `Start-XiyouAnswerHelper.bat`（会清掉 `ELECTRON_RUN_AS_NODE`，否则 Electron 会退化成 Node 打不开界面）。

使用细节见 `XiyouAnswerHelperDesktop/README.md`。

### 安卓版

直接安装 `XiyouAnswerHelperAndroid/XiyouAnswerHelper.apk`（Android 8.0+），或自行构建：

```powershell
cd XiyouAnswerHelperAndroid
powershell -ExecutionPolicy Bypass -File build.ps1
```

构建依赖 JDK 8（javac）、JDK 17（d8/apksigner）、Android build-tools 34 + platform 34，脚本不使用 Gradle。
安卓端说明见 `XiyouAnswerHelperAndroid/README.md`。

## 目录结构（源码部分）

```
XiyouAnswerHelper/
├─ XiyouAnswerHelperDesktop/
│  └─ resources/app/            Electron 主进程 + 界面源码（纯 JS）
│     ├─ main.js                监控 / 在线接口 IPC / 窗口
│     ├─ src/xiyou-api.js       在线接口与签名
│     ├─ src/paper-parser.js    试卷解析
│     └─ renderer/              界面（含 answer-format.js 排版）
└─ XiyouAnswerHelperAndroid/
   ├─ app/src/main/java/...     Activity / 协议 / 录音上传
   ├─ app/src/main/assets/www/  本地界面（HTML/CSS/JS）
   └─ build.ps1                 无 Gradle 构建脚本
```

## 免责声明

本项目仅用于个人学习与研究，用于读取本机已存在的数据，或按网页端相同方式请求试卷、上传作答语音。
请遵守学校规定与平台服务条款，勿用于任何违规用途。由此产生的一切后果由使用者自行承担。

## License

MIT
