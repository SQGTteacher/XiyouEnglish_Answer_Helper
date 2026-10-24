# 西柚答案助手 · 安卓版

登录西柚英语账号 → 选择作业 → 自动获取本次试题答案并排版显示。

- 直接安装根目录下的 **`XiyouAnswerHelper.apk`**（Android 8.0 及以上）
- 账号密码保存在本机，下次打开自动填充
- 默认只显示每题的**第一条答案**，需要时可打开「显示完整详细答案 / 踩分点」

---

## 一、使用步骤

1. 打开 App，输入西柚英语的**账号 / 手机号**和**密码**，点「登录」。
   - 勾选「记住账号密码」后，下次打开会自动带出。
2. 登录成功后自动列出当前待完成的作业（按作业本分组）。
   - 如果作业在作业本里，点进去再选具体题目。
   - 也可以点「手动输入 ID」，直接填试卷的 `groupId` 取答案。
3. 点作业后自动请求试卷并提取答案。
4. 答案页右上角：
   - `复制`：按下面的固定格式复制整份答案；
   - 开关「显示完整详细答案 / 踩分点」：额外显示题干、全部参考答案、关键词、得分要点、听力原文、选择题正确项；
   - 点某一条答案可以直接复制该条。

---

## 二、答案输出格式

简洁模式严格按照下面的格式，每个题目只取答案文件里的**第一项**：

```
（试题标题）

一、模仿朗读
<朗读原文 / 答案>

二、角色扮演
三问：
1. <第一项答案>
2. <第一项答案>
3. <第一项答案>
五答：
1. <第一项答案>
2. <第一项答案>
3. <第一项答案>
4. <第一项答案>
5. <第一项答案>

三、故事复述
<第一篇范文>
```

详细模式在每题下面追加：题干、全部参考答案、关键词、得分要点、听力/朗读原文。

---

## 三、实现原理

安卓端不依赖电脑客户端，直接复刻学生端网页的请求：

| 步骤 | 接口 |
|---|---|
| 登录 | `POST https://app.xiyouyingyu.com/user/login/account`（表单：`loginAccount` + 明文 `password`） |
| 作业列表 | `POST /homework/findBagListV2`（JSON：`userId` / `clazzId` / `homeworkStatus`） |
| 作业本明细 | `POST /homework/findListByBagIdV2` |
| 开始作答 / 取试卷 | `POST /paper/module/detail`（表单：`groupId`），响应 `data.result` 已含全部答案 |
| 兜底 | `POST /homework/findList`、`GET /paper/getPaperGroupById` |

请求公共参数与签名（与网页端 4.8.6 一致）：

```
appVersion=4.8.6  belong=1  device=web-pc  release=4.8.6
brand=1.7976931348623157e+308  osVersion=<Windows Chrome UA>
timestamp=<毫秒>  sessionId  userId
sign = md5( 按 key 升序拼接的 "k=v&k=v" + "_Sts100#@" )
请求头：release / device / sign / udid
```

- UA 使用电脑端 Chrome/87，`device=web-pc`，以走电脑端作答流程；
- `udid` 首次生成 32 位随机串后固定保存在本机；
- 服务器证书链不完整（电脑客户端本身忽略证书错误），App 仅对 `*.xiyouyingyu.com` 做了证书放行。

---

## 四、本地数据与安全

| 内容 | 位置 | 说明 |
|---|---|---|
| 账号、密码 | SharedPreferences（`xy_helper`） | 用 Android Keystore 的 AES-GCM 加密后保存 |
| 会话 sessionId | 同上 | 用于免登录，退出登录即清除 |
| udid | 同上 | 设备标识，固定不变 |
| 详细模式开关 | 同上 | 记忆上次选择 |

- 除 `app.xiyouyingyu.com` 外不访问任何服务器，不上传账号密码。
- App 不需要存储、相机、定位等权限，只申请网络权限。

---

## 五、构建（可选）

本目录已包含可直接安装的 `XiyouAnswerHelper.apk`。需要重新打包时：

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
```

依赖（工作区 `.toolchain` 下已备好）：

- JDK 8：`C:\Program Files\Android\jdk\...`，用于 `javac`
- JDK 17：`.toolchain\jdk17`，用于 `d8` / `apksigner`
- Android build-tools 34 + platform 34：`.toolchain\sdk`

构建脚本不用 Gradle：`aapt2 compile/link → javac → d8 → 重打包 assets → zipalign → apksigner`。

> 注意：aapt2 在 Windows 下会把 assets 路径打包成反斜杠，`build.ps1` 里已做重打包修正，不要省略这一步。

---

## 六、目录结构

```
XiyouAnswerHelperAndroid\
├─ XiyouAnswerHelper.apk          可安装包
├─ build.ps1                      构建脚本（无 Gradle）
├─ icon.png                       图标源图
├─ keystore\xyhelper.keystore     签名证书（口令 xyhelper2026）
└─ app\src\main\
   ├─ AndroidManifest.xml
   ├─ java\com\xiyou\answerhelper\
   │  ├─ MainActivity.java        WebView 容器、返回键、状态栏
   │  ├─ Bridge.java              JS ↔ 原生桥（登录/作业/试卷/复制）
   │  ├─ XiyouClient.java         请求签名、登录、作业、试卷
   │  └─ Store.java               账号加密存储
   ├─ res\                        图标、主题、字符串
   └─ assets\www\                 界面与解析
      ├─ index.html / style.css / app.js
      ├─ paper-parser.js          试卷 JSON → 结构模型
      └─ answer-format.js         结构模型 → 指定格式文本 / 详细数据
```

---

## 七、常见问题

**Q：登录提示「用户名或密码错误」？**
A：确认账号密码与电脑端登录的一致；如果账号是手机号绑定了多个学生账号，请用学生账号本身登录。

**Q：作业列表是空的？**
A：只列出当前待完成的作业；已完成的不会显示。可以让同学重新发布，或点「手动输入 ID」。

**Q：点作业提示「没有解析到答案」？**
A：这份试卷可能是纯练习/测评，服务器没有下发答案。

**Q：会不会被老师发现？**
A：App 的请求与电脑端网页完全一致，不修改服务器数据；是否使用请自行判断并遵守学校规定。

---

## 八、作答功能（1.1 新增）

答案页顶部的 **「开始作答」** 会按服务器下发的 `processList` 完整复刻做题流程：

| 步骤类型 | 行为 |
|---|---|
| 播放题干 | 自动播放题目音频（电脑端同款 CDN 音频），播完自动进入下一步 |
| 播放视频 | 画面 + 声音一起播放（视频层内嵌在页面里），播完自动继续 |
| 播放原文 | 自动播放听力/朗读原文音频 |
| 准备时间 | 按服务器给的秒数倒计时，可点「跳过等待」 |
| 录音作答 | 点「开始录音」，按题目限时倒计时录音；结束后停在本题，可「回放录音」「重新录音」，再点「下一步」 |

- 全程按原试卷顺序走完 42 个步骤（模仿朗读 → 角色扮演 → 故事复述），音频、视频、等待时间一个不少；
- 录音文件保存在 App 私有目录（`cache/rec/*.m4a`），可回放；
- 底部的「上一步 / 下一步」可随时回看或跳过。

> 说明：当前作答只做「听题 + 录音 + 回放」的完整流程，不自动向服务器交卷；交卷需要接入口语评测（SOE）与录音上传，后续可加。