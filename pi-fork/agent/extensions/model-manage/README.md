# pi-model-manage

交互式模型渠道管理面板（modeled on ccswitch）：在 pi TUI 中通过 `/model-manage` 新增 / 编辑 / 删除 / 查看 `~/.pi/agent/models.json` 中的 provider（渠道）。

## 使用

1. 在 pi TUI 中执行 `/model-manage`（仅 TUI 模式可用）
2. 主菜单选择操作：新增渠道 / 编辑渠道 / 删除渠道 / 查看当前配置 / 退出
3. 面板保持打开，完成一次操作后自动回到主菜单；选「退出」或按 Esc 关闭

保存后立即生效：

- 当前会话通过 `pi.registerProvider()` / `pi.unregisterProvider()` 同步注册/注销，无需 `/reload`
- `/model` 与新建会话每次打开都会重新读取 models.json，同样立即生效

## 功能

- **新增渠道**：向导收集 渠道 ID / 显示名称 / baseUrl / api（四种）/ apiKey / 模型列表。
  模型列表用树形编辑器逐层下钻：模型列表 → 单个模型 → 属性值，可逐模型新增/删除/重命名，属性逐项增删改。
- **编辑渠道**：字段子菜单逐项修改 baseUrl / apiKey / api / models / headers / authHeader；保存时与最新文件条目合并，保留未知字段。

### 树形模型编辑器（新增/编辑渠道共用）

- **模型列表**：每个模型一项（label=id，description=属性摘要），另有「＋ 新增模型」「⇣ 从上游获取模型」「← 完成」
- **上游获取**：从当前渠道 `GET {baseUrl}/models` 拉取模型列表（15s 超时），逐个选择或「全部填入」导入；重复项自动跳过；支持 `$ENV`/`${ENV}`/`!cmd`/字面量 apiKey 运行时解析，响应中的密钥字样会被脱敏
- **导入补全**：导入时自动带入参数——按模型 id 补全 `reasoning: true` + 八档 `thinkingLevelMap`（思考深度）/ `input`（含 image/vision 等关键字的模型自动加图像）/ `contextWindow` / `maxTokens` / 零成本 `cost`；上游返回的 `reasoning`/`input_modalities`/`context_window` 等能力字段会映射覆盖默认值，导入后可在属性层逐项修改
- **模型属性**：每个属性一项（label=属性名，description=当前值），另有重命名 id / 新增属性 / 删除属性 / 删除此模型 / 返回
- **属性值**：按类型编辑——id/name 文本、api 下拉、reasoning 布尔、input 字符串数组、contextWindow/maxTokens 正整数、cost/thinkingLevelMap/compat 及未知属性 JSON 值
- 未知字段原样保留；id 不可删除；模型至少保留 1 个；模型 id 不可重复
- **删除渠道**：确认对话框显示渠道 ID + baseUrl，确认后删除并注销。
- **查看当前配置**：只读列表显示 `id (name) · baseUrl · apiKey 掩码 · 模型数`；选中后编辑器展示该渠道 JSON 详情（apiKey 掩码显示）。

## 校验

- 渠道 ID 必须非空、无空白、且不与现有渠道重复
- baseUrl 必须能解析为 URL
- api 必须是 `openai-completions` / `openai-responses` / `anthropic-messages` / `google-generative-ai`
- models 至少 1 个模型且每个模型都有 `id`（模型级 `api` 同样校验）
- 校验失败会提示 error 并回到子菜单，已输入内容保留在草稿中

## 回滚

每次写入前自动备份到同目录：

```
~/.pi/agent/models.json.bak-model-manage-<yyyyMMdd-HHmmss>
```

写入为原子操作（临时文件 + `renameSync`）。如某次修改有问题：

```bash
ls -t ~/.pi/agent/models.json.bak-model-manage-* | head -1
cp "$(ls -t ~/.pi/agent/models.json.bak-model-manage-* | head -1)" ~/.pi/agent/models.json
# 然后在 pi 中 /reload（当前会话的注册状态由 registerProvider 管理，重启/新会话即恢复）
```

## 安全

- apiKey 在列表、通知、确认框与详情视图中一律掩码显示（`$***` / `***len`），任何 apiKey 字面量不会进入 LLM 上下文
- 除确认后的写入外，扩展在导入与运行中不会触碰 models.json
