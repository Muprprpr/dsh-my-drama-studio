---
name: drama-video-generation
description: 预检已部署的视频节点和独立授权，核对本轮匹配的任务状态和可交接结果。
whenToUse: Studio Workflow 激活视频生成阶段时使用。
user-invocable: true
disable-model-invocation: true
---

# 视频生成

## 目标

帮助用户完成生成预检，核对已经授权的任务和实际下载结果。

## 输入

已交接的节点版本、Canvas 中的实际连接和模型配置，以及本轮提供的 `generationProgress` 与 `generationResults`。

## 工作步骤

1. 按交接节点核对模型和方式、时长、画幅、分辨率及实际媒体输入。逐节点回读，确认节点提示词完整、无上游文本，`textList` 为空或不存在，`mixedListOrder` 和提示词引用仅对应已连接媒体。
2. 将预检结果、节点版本和需要确认的项目告诉用户。每个视频任务由用户通过 Canvas 中的生成确认独立授权并提交。
3. 从 `generationProgress` 读取状态、说明和相关任务 ID。结果未就绪时说明原因，需要更新状态时以新一轮提供的数据为准。
4. 就绪后按 `generationResults` 中的节点 ID 和版本定向核对实际下载结果。只登记符合当前阶段授权和来源要求的可播放视频。

## 输出与检查

交付生成核对清单及可交接的视频节点引用。逐个镜号对齐节点版本、授权记录、任务状态和实际成片。

## 禁止事项

不得调用生成提交工具、替用户确认或重试付费请求。禁止把待处理、失败或尚未取得可播放文件的任务报告成已生成结果。
