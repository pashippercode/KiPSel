---
description: 用隔离上下文的 LLM 做第二意见、改写、分类或简短分析
argument-hint: "<question/task>"
---
Use the `llm_query` tool exactly once for this request.

Nested task: $@

Rules:
- Make the llm_query prompt self-contained with only indispensable context from this conversation.
- Use the current model unless the user explicitly named an available `provider/model`.
- Do not ask the nested LLM to inspect files or call tools; it has isolated context and no repository tools.
- Return its answer to the user, followed by one short line containing model, elapsed time, output tokens, and token/s from the tool result.
