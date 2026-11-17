# 视频生成阶段

- **目标**　核对用户已独立授权的任务及其结果，整理验收需要的视频节点。
- **允许输入**　已交接的部署草稿和回合开始时提供的 `generationProgress`、`generationResults`。它们以已确认节点、节点版本和用户独立授权为依据。
- **必需产出**　根据 `generationProgress` 的状态、说明和相关任务 ID 报告等待、进行中或完成情况。就绪时，按 `generationResults` 的节点 ID 和版本定向核对，用 `drama_save_artifact` 保存符合要求的可播放视频引用。
- **完成条件**　可交接结果能够追溯到草稿版本、用户授权、任务和真实文件。用户在 Canvas 独立确认和提交。Stage Agent 禁止调用生成提交工具。
