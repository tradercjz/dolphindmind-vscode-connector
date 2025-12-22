# DolphinMind Vscode Connector

DolphinMind Vscode Connector 是一个 Visual Studio Code 扩展，旨在将 VS Code 编辑器连接到 DolphinMind AI Agent。通过建立 WebSocket 连接，它允许 AI Agent 实时地在编辑器中执行文件操作，提供流畅的辅助编程体验。

## ✨ 主要特性

*   **实时连接**: 通过 WebSocket 与 AI Agent 保持实时通信。
*   **全量写入 (Write File)**:
    *   支持“打字机”式的流式写入动画，提供直观的生成反馈。
    *   自动打开 Diff 视图，方便用户对比修改前后的差异。
*   **局部补丁 (Apply Patch)**:
    *   支持基于上下文的精确代码修改。
    *   提供可视化的修改动画：红色高亮显示删除内容，绿色高亮显示新增内容。
*   **自动化反馈**: 操作完成后自动向 Agent 发送确认 (ACK) 信号。

## 🚀 快速开始

### 1. 安装
通常作为 DolphinMind 解决方案的一部分,在chat.dolphindb.cloud 的Coding模式下，会自动安装。

### 2. 配置与连接
扩展在 VS Code 启动时 (`onStartupFinished`) 会自动尝试连接到 Agent 服务器。

默认配置：
*   **WebSocket URL**: `ws://127.0.0.1:8007/api/v1/ws/${USER_SLUG}`
*   **User Slug**: `local-test-user`

可以通过环境变量自定义连接（开发模式下）：
*   `AGENT_WS_URL`: 自定义完整的 WebSocket 连接地址。
*   `USER_SLUG`: 自定义用户标识符。

### 3. 使用
1.  启动 DolphinMind AI Agent 后端服务。
2.  打开 VS Code。
3.  扩展将自动连接。连接成功后，状态栏会显示 `AI Agent Connected`。
4.  在 Output (输出) 面板中选择 **"DolphinMind"** 频道可以查看详细的连接日志和操作记录。

## 🛠️ 开发指南

### 前置要求
*   Node.js
*   npm / pnpm

### 编译与运行
1.  安装依赖：
    ```bash
    npm install
    ```
2.  编译代码：
    ```bash
    npm run compile
    ```
3.  调试运行：
    *   在 VS Code 中按 `F5` 启动调试窗口。
    *   确保本地有运行在 `8007` 端口的 Agent 服务，或者修改代码中的连接配置。

## 📝 协议说明

扩展通过 WebSocket 接收 `EDITOR_COMMAND` 类型的消息：

*   **WRITE_FILE**: 用于覆盖整个文件内容。
*   **APPLY_PATCH**: 用于应用局部修改，格式如下：
    ```
    ------- SEARCH
    [查找的代码块]
    =======
    [替换的代码块]
    +++++++ REPLACE
    ```

## 📄 License
MIT
