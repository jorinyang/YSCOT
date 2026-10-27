# MCP 内容导入标准

> 适用于 YSCOT（Yice Strategy Course Operation Tool）课堂运营系统。MCP 服务端地址：`https://yscot.clawshell.online/mcp`（本地 `http://127.0.0.1:8899/mcp`）。

## 一、接入

- 传输：HTTP POST，JSON-RPC 2.0；
- 鉴权：`Authorization: Bearer <讲师个人 token>`；token 在工作台「模型与MCP → MCP 接入令牌」查看，可重置；
- 房间：所有工具都接受 `room`（4 位大写场次码），不传时使用默认房间；
- 返回：`result.content[0].text` 是 JSON 字符串；失败时带 `isError: true`。

```bash
curl -s https://yscot.clawshell.online/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 二、内容导入工具

| 工具 | 用途 | 对应后台位置 |
| --- | --- | --- |
| `votebank.put` | 导入投票题库 | 课堂后台 → 课堂管理 → 投票题库 |
| `material.put` | 导入课程素材（文件或外链） | 课堂后台 → 课堂管理 → 课程素材 |
| `card.put` | 导入行动卡 / 场景卡 | 课堂后台 → 课堂管理 → 行动卡 / 场景卡配置 |
| `rubric.put` | 导入作业评分标准 | 课堂后台 → 作业评分 → 评分标准 |

### 2.1 投票题库

```json
{
  "name": "votebank.put",
  "arguments": {
    "room": "6YCJ",
    "mode": "append",
    "presets": [
      {"question": "你从什么时候开始接触 AI？", "options": ["今天第一次", "半年内", "一到三年", "三年以上"]},
      {"question": "今天最想带走什么？", "options": ["方法", "工具", "案例", "同学"]}
    ]
  }
}
```

标准：

- `question` 必填，去除首尾空白后不能为空；
- `options` 至少 2 项、建议不超过 8 项，空选项会被忽略；
- `mode=append` 追加，`mode=replace` 清空后导入；
- 返回 `ids` 与当前题库总数；无效题目跳过，全部无效时返回错误；
- 同一道题重复导入会生成新 ID，不会自动去重。

### 2.2 课程素材

**方式 A：base64 文件**（≤ 10MB，写入房间素材库）

```json
{
  "name": "material.put",
  "arguments": {
    "room": "6YCJ",
    "name": "客户画像模板.xlsx",
    "filename": "customer-profile-template.xlsx",
    "type": "xlsx",
    "data_base64": "UEsDBBQAAAAI..."
  }
}
```

**方式 B：外链素材**

```json
{
  "name": "material.put",
  "arguments": {
    "room": "6YCJ",
    "name": "课程参考案例",
    "url": "https://example.com/case.pdf",
    "type": "pdf",
    "description": "课前阅读"
  }
}
```

标准：

- `name` 必填，是学员端显示的素材名；
- `data_base64` 与 `url` 二选一；`url` 只接受 `http(s)`；
- `filename` 可省略，默认使用 `name`；文件名中的特殊字符会被替换；
- 文件写入 `data/rooms/<ROOM>/uploads/`，返回可直接下载的 `url`；
- 外链素材保存在房间状态的 `materials` 中，学员端与文件素材合并展示；
- 单个文件超过 10MB 返回错误，不会截断。

### 2.3 行动卡 / 场景卡

```json
{
  "name": "card.put",
  "arguments": {
    "room": "6YCJ",
    "theme": "客户访谈复盘",
    "type": "行动卡",
    "content": "用 10 分钟写下今天访谈中最反常识的一句话，并说明它改变了什么判断。",
    "attrs": "10 分钟 / 个人 / 产出：一句话复盘"
  }
}
```

标准：

- `theme` 必填；
- `type` 建议使用 `行动卡` 或 `场景卡`，也允许自定义字符串；
- `content` 是卡片正文，支持换行；
- `attrs` 是自由文本属性，建议写清时长、参与方式、产出物；
- 不带 `id` 为新增，带 `id` 为更新；更新不存在的 ID 会报错；
- 导入后不会自动推送，需要在遥控器点名卡片中选择并推送。

### 2.4 作业评分标准

```json
{
  "name": "rubric.put",
  "arguments": {
    "room": "6YCJ",
    "task": "T1",
    "items": [
      {"t": "结构完整（六要素）", "pts": 6, "desc": "每缺一项扣 1 分"},
      {"t": "内容贴合业务场景", "pts": 4, "desc": "使用真实场景与数据"},
      {"t": "可执行性", "pts": 4, "desc": "分工、时间、预算可落地"},
      {"t": "风险预案", "pts": 3, "desc": "有具体应对动作"},
      {"t": "迭代过程", "pts": 3, "desc": "体现至少两轮指令链"}
    ]
  }
}
```

标准：

- `task` 对应作业关卡，常用 `T1`–`T6`；
- `items[].t` 为评分项，`pts` 为分值（数字），`desc` 为评分说明；
- 导入会覆盖该 `task` 的旧标准；未导入的关卡继续使用系统内置标准；
- 作业评分页会优先读取 MCP 导入的标准，再回落到内置标准。

## 三、在线答题的出题方式

`quiz.publish` 支持两种模式：

| mode | 行为 |
| --- | --- |
| `random` | **每个学员独立随机抽题**：同一场答题，不同学员的题目顺序与题目组合可以不同；新加入的学员进入页面时也会生成自己的随机卷 |
| `seq` | 所有学员使用同一套顺序卷 |

```json
{
  "name": "quiz.publish",
  "arguments": {
    "room": "6YCJ",
    "mode": "random",
    "counts": {"choice": 5, "judge": 3, "blank": 2, "short": 1},
    "scores": {"choice": 2, "judge": 2, "blank": 3, "short": 10}
  }
}
```

说明：

- `counts` 是每种题型的抽题数，题库不足时按实际数量出题；
- 每名学员的试卷独立生成并保存在房间状态中，提交时按本人试卷评分；
- 课堂后台的「随机（每人不同）」等同于这里的 `random`。

## 四、错误与校验

| 情况 | 返回 |
| --- | --- |
| 缺少 token / token 错误 | HTTP 401 |
| 必填字段为空 | `isError: true` + 错误文本 |
| 素材超过 10MB | `isError: true` + 大小提示 |
| 文件与 URL 都未提供 | 报错，不落库 |
| 题目选项不足 2 个 | 跳过该题；全部无效则报错 |
| 更新不存在的卡片 ID | 报错，不新增 |

## 五、建议的导入顺序

1. `votebank.put` 导入投票题库；
2. `material.put` 导入课程素材；
3. `card.put` 导入行动卡 / 场景卡；
4. `rubric.put` 导入作业评分标准；
5. 课堂开始前用 `room.state` 或后台页面核对内容是否齐全。

所有写入都会更新房间的 `updatedAt`，学员端下一轮轮询即可看到。
