# 西柚英语个人版 —— 作业试题答案存储位置与文件格式（逆向分析报告）

> 分析对象：`D:\web-desktop\西柚英语个人版.exe`（Electron 11.3.0 / Chromium 87.0.4280.141，package name = `web-desktop`）
> 分析日期：2026-10-06
> 所有结论均在真实运行环境下抓包 + 内存 + 磁盘三方交叉验证。

---

## 一、结论速查

| 项目 | 结果 |
|---|---|
| 触发动作 | 班级 → 作业 → 去完成 → **开始答题** |
| 答案来源接口 | `POST https://app.xiyouyingyu.com/paper/module/detail`（另有 `/paper/getPaperGroupById`） |
| 落盘目录 | `%APPDATA%\web-desktop\Session Storage\` |
| 落盘文件 | LevelDB：`*.log`（WAL 预写日志）/ `*.ldb`（SSTable）/ `CURRENT` / `MANIFEST-000001` |
| 记录键 | `map-1-vuex`（namespace 1 = `https://student.xiyouyingyu.com`） |
| 值编码 | **UTF-16LE**，无前缀字节，内容是 JSON 字符串 |
| 答案 JSON 路径 | `JSON.params.paperGroupList` |
| 答案字段 | `oralTypeModel.answerTxt` / `.key` / `.points` / `.refText` / `.questionText` / `.choiceList` |
| 块压缩 | Snappy（block type = 1） |

---

## 二、客户端结构

```
D:\web-desktop\
├─ 西柚英语个人版.exe        Electron 11.3.0（Chromium 87 / Node 12.18.3）
├─ resources\app.asar        业务外壳（仅 3MB）
│   ├─ main.js               BrowserWindow + nodeIntegration:true + webSecurity:false
│   ├─ index.html            单个 <iframe>
│   └─ renderer.js           iframe.src = https://student.xiyouyingyu.com?mac=<硬盘序列号>&appVersion=3.0.0
└─ resources\elevate.exe
```

**本质**：Electron 只做了一个 iframe 容器，真正的业务全部是网页
`https://student.xiyouyingyu.com`（webpack 打包的 Vue2 SPA）。
后端 API 域名为 `https://app.xiyouyingyu.com`。

> 附注：外壳页开启了 `nodeIntegration:true` / `webSecurity:false`，
> 且 `renderer.js` 里的 `window.addEventListener('message', e => msgHandle(e.data))`
> **未校验 origin**，任何能向该窗口 postMessage 的页面都能调用 `openDevTools`、
> 读写 `electron-localstorage`。属于外壳的安全缺陷（本工具并未使用该路径）。

---

## 三、答案是怎么产生的

### 3.1 代码路径

在 `funny.d2732836.js` 中，「开始答题」按钮绑定 `exercises()`：

```js
async exercises(t) {
  await this.common.checkResourceCdnDomain();
  ...
  // ① 把整份试卷（含答案）写入 Vuex
  this.$store.dispatch("params/setPaperGroupList", this.list);
  ...
  // ② 预下载该试卷用到的全部音频/视频/图片（这就是"下载试题"）
  this.preload(() => {
    this.$store.dispatch("params/setAudioList", this.audioList);
    this.$router.push({ name: "paperDetail", query: a });
  });
}
```

`this.list` 就是 `POST /paper/module/detail` 返回的试卷数据 —— **答案已经内嵌在里面**，
客户端只是把它原样放进 Vuex。

### 3.2 Vuex 持久化

`app.e77d6a14.js` 中的 vuex-persistedstate 插件：

```js
plugins: [
  persistedstate({ storage: window.localStorage,  reducer: e => ({ local: e.local }) }),
  persistedstate({ storage: window.sessionStorage, reducer: e => ({
    isMaximized, keepAliveInclude, Counter, user, refresh, params, app
  })})
]
```

`params` 在 sessionStorage 的 reducer 白名单里，因此
**`sessionStorage["vuex"]` → `.params.paperGroupList` 就是完整试卷 + 全部答案**。

实测体量：`sessionStorage["vuex"]` ≈ 102,846 字符（约 200 KB UTF-16）。

### 3.3 完整时序（实测）

```
点击「开始答题」
   ↓  POST /paper/module/detail            ← 109,667 字节，含全部答案
   ↓  POST /paper/getPaperGroupById        ← 111,923 字节
   ↓  sessionStorage.setItem("vuex", …)    ← 2,652 → 102,846 字符  ★答案落内存
   ↓  预下载 mp3/mp4/png → %APPDATA%\web-desktop\Cache\f_xxxxxx
   ↓  Chromium DOMStorage 提交定时器触发
   ↓  %APPDATA%\web-desktop\Session Storage\000004.log  ← ★答案落磁盘
```

注意：进入答题页后应用会调用 `clearParams()` 把 `paperGroupList` 清空，
所以**内存里的答案只存在很短一段时间**；但 LevelDB 的旧版本记录（含 WAL）
仍然保留，且本工具会在第一次读到时就持久化保存。

---

## 四、磁盘格式细节

### 4.1 目录

```
%APPDATA%\web-desktop\
├─ Session Storage\        ← sessionStorage（答案在这里）
│   ├─ 000004.log          WAL，206 KB，含完整答案
│   ├─ 000005.ldb          SSTable
│   ├─ CURRENT / MANIFEST-000001 / LOG / LOG.old
├─ Local Storage\leveldb\  ← localStorage
│   └─ 000003.log
└─ Cache\                  ← 试题音视频/图片（HTTP 缓存，POST 响应不入此缓存）
```

### 4.2 键的命名

| 存储 | 键格式 | 例子 |
|---|---|---|
| Session Storage | `map-<namespace>-<key>` | `map-1-vuex`、`map-0-vuex` |
| Local Storage | `_<origin>\x00\x01<key>` | `_https://student.xiyouyingyu.com\x00\x01vuex` |

`namespace` 对应关系记录在同库的 `namespace-<dbid>-<origin>` 键里：

* `1` → `https://student.xiyouyingyu.com`（业务页面）
* `0` → `file:///`（Electron 外壳页面）

### 4.3 值的编码

* **Session Storage**：值 = 直接是 **UTF-16LE** 字节，无前缀。→ `buf.toString('utf16le')`
* **Local Storage**：值 = `0x01` + UTF-8 字节。→ `buf.slice(1).toString('utf8')`
  （另有 `0x00` 前缀代表 UTF-16，本应用未出现）

### 4.4 LevelDB 物理格式（本工具已完整实现纯 JS 解析）

```
Table 文件 (.ldb/.sst)：
  [data block]... [metaindex block] [index block] [footer 48B]
  footer = metaindexHandle(varint off,varint size)
         + indexHandle(varint off,varint size)
         + 40B 填充 + magic 0xdb4775248b80fb57(LE: 57 fb 80 8b 24 75 47 db)
  BlockHandle.size = 「块体」长度，**不含**尾部 5 字节 trailer
  Block = 块体 + [压缩类型 1B][CRC32 4B]
  块体 = 若干条目 + restart 数组 + restartCount(u32 LE)
  条目 = sharedLen(varint) + unsharedLen(varint) + valueLen(varint) + keyDelta + value

WAL 文件 (.log)：
  记录 = CRC32(4) + length(2,LE) + type(1) + data
  type: 1=FULL 2=FIRST 3=MIDDLE 4=LAST 0=零填充
  data 为 write batch：seq(u64 LE) + count(u32 LE) + count × [kType(1) + key + value]
  kType: 1=PUT 0=DELETE

压缩：块类型 1 = Snappy（纯 JS 解压即可）
内部键：Table 中 key 末尾 8 字节 = (sequence << 8 | type)，WAL 中无此后缀
```

### 4.5 答案 JSON 结构

```
sessionStorage["vuex"]
└─ JSON
   └─ params
      └─ paperGroupList : [            ← 大题数组
           {
             id, name:"模仿朗读", enName:"Reading Aloud",
             questionsName:"突破高中英语听说基础版模拟试题01_模仿朗读",
             totalScore: 20, num: 1,
             smallList: [              ← 材料/小题
               {
                 name, score, templateId,
                 processList: [        ← 作答步骤
                   {
                     seq, processTypeId,          // 1播放题干 2播放原文 3等待 4录音作答 5播放视频
                     name: "录音作答",
                     infoData: { content, audioURL, ... },
                     oralTypeModel: {                ★★★ 答案在这里
                        id, name: "问答题" | "翻译" | "段落" | "故事复述",
                        score, precision, rateScale,
                        questionText: "Where was the first Grammy Awards ceremony held?",
                        answerTxt:    "In Los Angeles and New York.\nIt was held in ...",   // 参考答案（多行）
                        key:          "Los Angeles New York\nNew York Los Angeles",        // 判分关键词
                        points:       "Mr. Smith was a busy driver...\n...",                // 得分要点（故事复述）
                        refText:      "M: Do you think this music is beautiful...",         // 听力/朗读原文
                        choiceList: [ { text, optionsTypeList: [ { text, answer:true } ] } ] // 选择题
                     }
                   }
                 ]
               }
             ]
           }, ...
         ]
```

题型与答案字段对照：

| 题型 | 答案字段 |
|---|---|
| 模仿朗读（段落） | 无 `answerTxt`，答案 = `refText`（朗读原文） |
| 角色扮演 · 翻译 | `answerTxt`（多行参考译法） + `key` |
| 角色扮演 · 问答 | `answerTxt` + `key` + `refText`（听力原文） |
| 故事复述 | `answerTxt`（多篇范文，HTML `<blockquote>` 包裹） + `points`（要点） |
| 选择题 | `choiceList[].optionsTypeList[].answer === true` |

---

## 五、其它可用的答案接口（未使用，仅供参考）

`app.e77d6a14.js` 中 `$urls` 定义的答案相关接口（前缀 `https://app.xiyouyingyu.com`）：

```
/paper/module/detail            整份试卷（含答案）★ 本次利用
/paper/module/answer
/paper/getPaperGroupById
/word/findHomeworkAnswerList    作业答案列表
/word/getAnswerList
/word/selectByUIdItemIdType
/write/getAnswer                书面表达答案
/homework/getItemDetail
/homework/getItemScore
/homeworkExam/findExamList
```

---

## 六、顺带发现的安全问题

1. `resources/app.asar` 未加密，可用任意 asar 工具解包。
2. 外壳 `nodeIntegration:true` + `webSecurity:false`，且 `postMessage` 未校验 origin。
3. **`localStorage["vuex"]` 的 `local` 字段以明文保存了账号密码**
   （`{"local":{"phone":"…","password":"…","keepPSW":true,"autoLogin":true}}`），
   任何能读取该机器配置目录的程序都能直接拿到账号密码。
4. 会话 token（`sessionId`、OSS 的 `accessKeyId/Secret`）明文存在于
   `sessionStorage["vuex"]` 与 `sessionStorage["COMMON_BASIC_INFO"]` 中。

---

## 七、本工具的实现选择

既然答案落在 **LevelDB** 里，最稳的做法是自己实现一个只读的 LevelDB 解析器，
于是「西柚答案助手」完全不依赖原生模块、不改动原客户端、不需要注入：

1. 每 1.2 秒扫描 `%APPDATA%\web-desktop\Session Storage` 与 `Local Storage\leveldb`；
2. 纯 JS 解析 `.log` / `.ldb`，Snappy 解块，剥掉内部键后缀，按 sequence 取全部版本；
3. 找 `map-*-vuex`，UTF-16LE 解码 → JSON → `params.paperGroupList`；
4. 取「最新且真的含答案」的版本（这样即使应用随后清空了内存，也仍能拿到）；
5. 解析成大题 / 材料 / 题目 / 参考答案 / 关键词 / 要点 / 原文，置顶展示；
6. 结果同时持久化到 `%APPDATA%\XiyouAnswerHelper\papers.json`。

另外，若客户端以 `--remote-debugging-port=9222` 启动，
工具会额外接一条 CDP 实时通道（自实现 RFC6455 WebSocket 客户端），
读取延迟从秒级降到亚秒级；两条通道互为备份，任一可用即可工作。
