# MCP 接入与排错

> 给第一次接 YSCOT MCP 的讲师 / 开发者 / AI Agent。字段级标准见 [MCP 内容导入标准](09-MCP内容导入标准.md)。

## 一、先认清：/mcp 不是普通网页

`https://yscot.clawshell.online/mcp` 是一个 **HTTP POST + JSON-RPC 2.0** 的 MCP 端点，不是浏览器里打开的页面。

- 浏览器直接打开：会看到一页接入说明（正常）；
- 用 GET 调：服务端返回 405；
- 不带 `Authorization` 调：返回 `401 unauthorized`；
- AI Agent 看到 401 时，应该补 token，**不要再去抓网页后台**。

## 二、准备令牌（每个讲师一套）

MCP 令牌在**讲师登录后的个人页面**生成和查看，不在服务器环境变量里手工配：

1. 登录 YSCOT 工作台；
2. 打开「个人信息」；
3. 找到「MCP 接入令牌」，点「复制」；
4. 如果怀疑泄露，点「重置」——旧 token 立即失效，再把新 token 填回 MCP 客户端。

规则：

- 每个讲师一个 token，只对**自己的场次**生效；管理员 token 可看全部；
- token 只显示给当前登录账号，不要写进前端、仓库或发群；
- 重置不需要重启服务，调用立即生效；
- 令牌丢了直接重置，不需要找回旧值。

请求头固定为：

~~~http
Authorization: Bearer <你的个人 token>
Content-Type: application/json
~~~
## 三、客户端配置

通用 MCP HTTP 客户端（字段名以你的客户端为准）：

~~~json
{
  "mcpServers": {
    "yscot": {
      "type": "http",
      "url": "https://yscot.clawshell.online/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_TOKEN>"
      }
    }
  }
}
~~~

如果客户端要求“命令 + 参数”的形式，用 `curl` 或任意 HTTP 客户端包一层即可；服务端不依赖特定客户端。

## 四、三步验证

### 1. 列工具

~~~bash
export MCP_TOKEN='...'
curl -s https://yscot.clawshell.online/mcp \
  -X POST \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
~~~

看到 `"tools"` 数组即表示端点、令牌、方法都通了。

### 2. 初始化

~~~bash
curl -s https://yscot.clawshell.online/mcp \
  -X POST \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}'
~~~

### 3. 调一个内容工具

~~~json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "votebank.put",
    "arguments": {
      "room": "YQ2X",
      "mode": "append",
      "presets": [
        {
          "question": "你从什么时候开始接触 AI？",
          "options": ["今天第一次", "半年内", "一到三年", "三年以上"]
        }
      ]
    }
  }
}
~~~

返回结构：

~~~json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      { "type": "text", "text": "{\"ok\":true,\"count\":1}" }
    ]
  }
}
~~~

`result.content[0].text` 是 JSON 字符串；业务失败时还会带 `isError: true`。

## 五、四类内容导入

### 1. 投票题库（遥控器用）

~~~json
{
  "name": "votebank.put",
  "arguments": {
    "room": "YQ2X",
    "mode": "append",
    "presets": [
      { "question": "你对 AI 的了解程度", "options": ["不了解", "听说过", "简单了解", "深度使用"] }
    ]
  }
}
~~~

- `mode=append` 追加；`mode=replace` 清空后导入；
- `options` 至少 2 项；
- **只用于遥控器投票，不会自动进入在线答题题库。**

### 2. 课程素材（学员端下载）

base64 文件（≤ 10MB）：

~~~json
{
  "name": "material.put",
  "arguments": {
    "room": "YQ2X",
    "name": "客户画像模板.xlsx",
    "filename": "customer-profile-template.xlsx",
    "type": "xlsx",
    "data_base64": "UEsDBBQAAAAI..."
  }
}
~~~

外链：

~~~json
{
  "name": "material.put",
  "arguments": {
    "room": "YQ2X",
    "name": "课程参考案例",
    "url": "https://example.com/case.pdf",
    "type": "pdf",
    "description": "课前阅读"
  }
}
~~~

### 3. 行动卡 / 场景卡

~~~json
{
  "name": "card.put",
  "arguments": {
    "room": "YQ2X",
    "theme": "客户访谈复盘",
    "type": "行动卡",
    "content": "用 10 分钟写下今天访谈中最反常识的一句话，并说明它改变了什么判断。",
    "attrs": "10 分钟 / 个人 / 产出：一句话复盘"
  }
}
~~~

导入后还要在遥控器的「工作坊 / 卡片」里选择并推送，不会自动投屏。

### 4. 作业评分标准

~~~json
{
  "name": "rubric.put",
  "arguments": {
    "room": "YQ2X",
    "task": "T1",
    "items": [
      { "t": "结构完整（六要素）", "pts": 6, "desc": "每缺一项扣 1 分" },
      { "t": "内容贴合业务场景", "pts": 4, "desc": "使用真实场景与数据" },
      { "t": "可执行性", "pts": 4, "desc": "分工、时间、预算可落地" },
      { "t": "风险预案", "pts": 3, "desc": "有具体应对动作" },
      { "t": "迭代过程", "pts": 3, "desc": "体现至少两轮指令链" }
    ]
  }
}
~~~

`task` 用 `T1`–`T6`；同一关卡重复导入会覆盖旧标准。

## 六、AI Agent 推荐调用顺序

1. `initialize` → `tools/list`，确认连接；
2. `room.list` 找到场次码；
3. 按需依次 `votebank.put` → `material.put` → `card.put` → `rubric.put`；
4. 用 `room.state` 或后台页面核对内容；
5. 课堂开始前再用 `quiz.publish` 发布答题（题库要先有题）。

> 投票题和答题题库是两套数据。投票题只在遥控器里出现；在线答题要先在后台「在线答题」导入题库，或用 MCP 导入答题题库后发布。

## 七、语音控制遥控器

MCP 除了导入内容，也能执行遥控器上的现场动作。语音 Agent 的推荐顺序：

1. 先调 `remote.state` 看当前房间状态：投票、答题、计时、分组、卡片、素材/作业开关；
2. 再调 `remote.control` 执行一个动作；
3. 返回结果里带最新状态，可以让 Agent 复述「现在大屏是报告、投票进行中」。

~~~json
{
  "name": "remote.state",
  "arguments": { "room": "YQ2X" }
}
~~~

~~~json
{
  "name": "remote.control",
  "arguments": {
    "room": "YQ2X",
    "action": "screen.set",
    "view": "report"
  }
}
~~~

常用口令到动作：

| 讲师说法 | action | 额外参数 |
| --- | --- | --- |
| 大屏切到报告 / 切数据 | `screen.set` | `view: "report"`（内部映射到 data） |
| 大屏切到课件 | `screen.set` | `view: "course"` |
| 大屏切到工作坊 | `screen.set` | `view: "workshop"` |
| 发素材 / 关素材 | `material.open` / `material.close` / `material.toggle` | — |
| 开作业 / 关作业 | `hw.open` / `hw.close` / `hw.toggle` | — |
| 开始投票 | `poll.start` | 先 `remote.state` 取 `presets`，传 `presetId`；也可传 `question` + `options` |
| 结束投票 | `poll.stop` | — |
| 抽一位 / 停止抽取 | `roll.start` / `roll.stop` | — |
| 开抢答 / 开始抢答 | `buzz.enable` / `buzz.start` | — |
| 关抢答 | `buzz.disable` | — |
| 开始答题 / 结束答题 | `quiz.start` / `quiz.close` | `mode`、`counts`、`scores` 可省略，默认沿用答题配置 |
| 开始计时 / 暂停 / 重置 | `timer.start` / `timer.pause` / `timer.reset` | `minutes` 默认 90 |
| 打开/关闭工作坊 | `workshop.open` / `workshop.close` | — |
| 推一张卡片 | `card.push` | 先 `remote.state` 取 `cards`，传 `cardId` |
| 收回卡片 | `card.withdraw` | — |
| A 组加两分 | `group.score` | `group: "A", delta: 2` |

说明：

- 所有动作都要带 4 位场次码 `room`；
- 返回 `result.content[0].text` 是 JSON，含 `ok` 和最新 `state`；
- 遥控器页面每 2.5 秒轮询，MCP 改完状态会自动出现在讲师手机和大屏；
- 讲师个人 Token 只能操作自己的场次，管理员/服务令牌才能跨场次。

## 八、常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `401 unauthorized` | 没带 token / token 不匹配 / 已被重置 | 检查 `Authorization: Bearer ...`；到「个人信息」重新复制；确认没有在别处重置过 |
| 浏览器打开是一页 HTML | 这是接入说明，不是报错 | 用 POST JSON-RPC 调用 |
| `405` | 用了 GET 或 PUT | 改为 POST；请求体是 JSON-RPC |
| `-32600 / Invalid Request` | JSON 不合法或缺 `jsonrpc/method` | 用 `initialize` / `tools/list` / `tools/call` |
| `room not found` / 默认房间 | 场次码错误 | 用 4 位大写场次码，如 `YQ2X` |
| 工具返回“题库为空” | 在线答题题库为空 | 先在「在线答题」导入题库；投票题不算答题题库 |
| 素材失败 | 超过 10MB 或既无 `data_base64` 也无 `url` | 压缩文件或改用外链；两个字段二选一 |
| 请求体被拒 | 超过 16MB | 大文件走 `url` 外链，或拆分成多个请求 |

## 九、安全

- 令牌只放服务端环境变量，不进前端、不进 GitHub、不发群；
- 泄露后立即更换 `MCP_TOKEN` 并重启容器；
- Agent 只需要 MCP 端点，不需要登录钉钉后台；拿到 401 时应向操作者要 token，而不是猜路径或抓页面。
