import * as vscode from 'vscode';
import WebSocket from 'ws';

// --- 1. 定义新的协议类型 ---
interface EditorCommandMsg {
    type: 'EDITOR_COMMAND';
    nonce?: string;
    command: 'WRITE_FILE' | 'APPLY_PATCH';
    payload: {
        filePath: string;
        content?: string; // 用于 WRITE_FILE
        diff?: string;    // 用于 APPLY_PATCH
        mode?: 'overwrite' | 'diff';
    };
}

// 定义 Patch 结构
interface CodePatch {
    search: string;
    replace: string;
}

const SCHEME = 'cline-diff';
const originalContentMap = new Map<string, string>();

// 装饰器样式
const activeLineDec = vscode.window.createTextEditorDecorationType({
    backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
    isWholeLine: true
});
const fadedDec = vscode.window.createTextEditorDecorationType({ opacity: '0.5' });
// 新增：删除线/红色背景 (用于 Patch 删除)
const deleteDec = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 0, 0, 0.2)',
    isWholeLine: true
});
// 新增：绿色背景 (用于 Patch 插入)
const insertDec = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(0, 255, 0, 0.2)',
    isWholeLine: true
});

class ContentProvider implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
        return originalContentMap.get(uri.path) || "";
    }
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Activating Cline Agent Client...');
    // Dedicated output channel for easier log collection (works better in remote/code-server)
    const out = vscode.window.createOutputChannel('DolphinMind');
    context.subscriptions.push(out);
    out.appendLine('Activating Cline Agent Client...');

    context.subscriptions.push(
        vscode.workspace.registerTextDocumentContentProvider(SCHEME, new ContentProvider())
    );

    // --- 连接配置 ---
    // 建议从配置或环境变量读取，这里演示用写死
   const USER_SLUG = process.env.USER_SLUG || "local-test-user";
    
    // 优先读取注入的完整 URL，如果没有则拼接本地 URL
    let wsUrl = process.env.AGENT_WS_URL;
    if (!wsUrl) {
        // 本地调试回退
        wsUrl = `ws://127.0.0.1:8007/api/v1/ws/${USER_SLUG}`;
    }

    console.log(`[Identity] Current User: ${USER_SLUG}`);
    out.appendLine(`[Identity] Current User: ${USER_SLUG}`);

    let ws: WebSocket | null = null;

    // --- 状态管理 ---
    let lineQueue: string[] = [];
    let isAiFinished = false;
    let isConsuming = false; // 新增：防止重复消费
    let activeEditor: vscode.TextEditor | undefined;
    let currentLineIndex = 0;
    let currentNonce: string | undefined = undefined;

    // --- 核心：消息路由 ---
    async function handleMessage(msg: EditorCommandMsg) {
        out.appendLine('ENTER handleMessage');
        console.log('ENTER handleMessage');
        try {
            if (msg.type !== 'EDITOR_COMMAND') {
                out.appendLine('EXIT handleMessage (not EDITOR_COMMAND)');
                console.log('EXIT handleMessage (not EDITOR_COMMAND)');
                return;
            }

            const { command, payload } = msg;
            currentNonce = msg.nonce; 

            // 场景 1: 全量写入 / 打字机模式
            if (command === 'WRITE_FILE') {
                out.appendLine('handleMessage: WRITE_FILE');
                console.log('handleMessage: WRITE_FILE');
                // 停止之前的动画
                resetQueue();
                await prepareEditorForWrite(payload.filePath, payload.content || "");
            } 
            // 场景 2: 局部修改 / Patch 模式
            else if (command === 'APPLY_PATCH') {
                out.appendLine('handleMessage: APPLY_PATCH');
                console.log('handleMessage: APPLY_PATCH');
                resetQueue(); // Patch 不走流式队列，走原子动画
                await handleApplyPatch(payload.filePath, payload.diff || "");
            }

            out.appendLine('EXIT handleMessage');
            console.log('EXIT handleMessage');
        } catch (e) {
            console.error("Error handling message:", e);
            out.appendLine(`Error handling message: ${String(e)}`);
            vscode.window.showErrorMessage(`Agent Error: ${e}`);
            out.appendLine('EXIT handleMessage (error)');
            console.log('EXIT handleMessage (error)');
        }
    }

    function sendAck() {
        out.appendLine('ENTER sendAck');
        console.log('ENTER sendAck');
        if (ws && ws.readyState === WebSocket.OPEN && currentNonce) {
            ws.send(JSON.stringify({
                type: "CLIENT_ACK",
                nonce: currentNonce,
                status: "success"
            }));
            console.log(`Sent ACK for ${currentNonce}`);
            out.appendLine(`Sent ACK for ${currentNonce}`);
            currentNonce = undefined; // 清空，防止重复发送
        }
        out.appendLine('EXIT sendAck');
        console.log('EXIT sendAck');
    }

    // =========================================================
    // 场景 1 实现: 全量写入 (Write File)
    // =========================================================
    async function prepareEditorForWrite(relPath: string, fullContent: string) {
        out.appendLine(`ENTER prepareEditorForWrite: ${relPath}`);
        console.log(`ENTER prepareEditorForWrite: ${relPath}`);
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
            out.appendLine('EXIT prepareEditorForWrite (no workspace folder)');
            console.log('EXIT prepareEditorForWrite (no workspace folder)');
            return;
        }
        const targetUri = vscode.Uri.joinPath(wsFolder.uri, relPath);

        // 1. 准备 Diff 左侧 (Snapshot)
        let originalContent = "";
        try {
            const bytes = await vscode.workspace.fs.readFile(targetUri);
            originalContent = new TextDecoder().decode(bytes);
        } catch { /* new file */ }
        originalContentMap.set(targetUri.path, originalContent);

        // 2. 准备 Diff 右侧 (清空)
        const leftUri = vscode.Uri.parse(`${SCHEME}:${targetUri.path}`);
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.createFile(targetUri, { overwrite: true, ignoreIfExists: true });
        await vscode.workspace.applyEdit(wsEdit);

        // 3. 打开视图
        await vscode.commands.executeCommand('vscode.diff', leftUri, targetUri, `AI Editing: ${relPath}`);
        
        activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            out.appendLine('EXIT prepareEditorForWrite (no active editor)');
            console.log('EXIT prepareEditorForWrite (no active editor)');
            return;
        }

        // 4. 清空当前内容
        await activeEditor.edit(b => {
            const lastLine = activeEditor!.document.lineCount;
            b.delete(new vscode.Range(0, 0, lastLine, 0));
        });

        // 5. 将后端传来的 Full Content 拆分为行，放入队列开始动画
        lineQueue = fullContent.split('\n').map(line => line + '\n'); // 补回换行符
        isAiFinished = true; // 因为是一次性传来的，所以直接标记结束
        currentLineIndex = 0;
        
        processQueue();
        out.appendLine('EXIT prepareEditorForWrite');
        console.log('EXIT prepareEditorForWrite');
    }

    async function processQueue() {
        out.appendLine('ENTER processQueue');
        console.log('ENTER processQueue');
        if (isConsuming) {
            out.appendLine('EXIT processQueue (isConsuming)');
            console.log('EXIT processQueue (isConsuming)');
            return; // 防止重入
        }
        isConsuming = true;

        // 只要队列不为空，就一直处理
        while (lineQueue.length > 0) {
            if (!activeEditor) break;

            const chunk = lineQueue.shift();
            if (!chunk) continue;

            try {
                // 1. 写入内存
                await activeEditor.edit(b => {
                    b.insert(new vscode.Position(currentLineIndex, 0), chunk);
                });

                // 2. 动效 (高亮当前行)
                // 滚动动效偶尔会打断用户，可以选择每隔几行滚动一次
                const range = new vscode.Range(currentLineIndex, 0, currentLineIndex, 0);
                activeEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                activeEditor.setDecorations(activeLineDec, [range]);
                
                if (currentLineIndex > 0) {
                    activeEditor.setDecorations(fadedDec, [new vscode.Range(0, 0, currentLineIndex - 1, 0)]);
                }

                currentLineIndex++;

                // 3. 微小延时 (控制打字机速度，太快了像直接粘贴，太慢了浪费时间)
                // 使用 await 暂停，而不是阻塞线程
                await new Promise(r => setTimeout(r, 20)); 

                } catch (e) {
                console.error("Render error:", e);
                out.appendLine(`Render error: ${String(e)}`);
                break;
            }
        }

        isConsuming = false;

        // 队列处理完了，检查是否结束
        if (lineQueue.length === 0 && isAiFinished) {
            await finishLogic();
        }
        out.appendLine('EXIT processQueue');
        console.log('EXIT processQueue');
    }

    // =========================================================
    // 场景 2 实现: 局部修改 (Apply Patch)
    // =========================================================
    async function handleApplyPatch(relPath: string, diffContent: string) {
        out.appendLine(`ENTER handleApplyPatch: ${relPath}`);
        console.log(`ENTER handleApplyPatch: ${relPath}`);
        // 1. 打开文件 (Patch 模式通常不需要 Diff 视图，直接在原文件改体验更好)
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) {
            out.appendLine('EXIT handleApplyPatch (no workspace folder)');
            console.log('EXIT handleApplyPatch (no workspace folder)');
            return;
        }

    // Normalize incoming path: support relative paths, absolute paths that include the workspace path,
        // and full vscode-remote/file URIs passed from the agent.
        let targetUri: vscode.Uri;
    let doc: vscode.TextDocument | undefined;
        try {
            // If the agent already sent a full URI, parse and use it directly
            if (relPath.startsWith('vscode-') || relPath.startsWith('vscode:') || relPath.startsWith('file:') || relPath.startsWith('http')) {
                targetUri = vscode.Uri.parse(relPath);
            } else {
                // Remove any leading workspace path duplication or leading slashes
                const wsPath = wsFolder.uri.path || '';
                let normalized = relPath;
                if (normalized.startsWith(wsPath)) {
                    normalized = normalized.slice(wsPath.length);
                }
                normalized = normalized.replace(/^\/+/, '');
                // Join with workspace folder URI
                targetUri = vscode.Uri.joinPath(wsFolder.uri, normalized);
            }

            out.appendLine(`Resolved targetUri: ${targetUri.toString()}`);
            console.log(`Resolved targetUri: ${targetUri.toString()}`);

            // Check existence before opening to produce clearer error messages
            try {
                await vscode.workspace.fs.stat(targetUri);
            } catch (statErr) {
                out.appendLine(`File not found: ${targetUri.toString()} - ${String(statErr)}`);
                console.error(`File not found: ${targetUri.toString()}`, statErr);
                vscode.window.showErrorMessage(`Could not find target file: ${targetUri.path}`);
                out.appendLine('EXIT handleApplyPatch (file not found)');
                console.log('EXIT handleApplyPatch (file not found)');
                return;
            }

            doc = await vscode.workspace.openTextDocument(targetUri);
            activeEditor = await vscode.window.showTextDocument(doc);
        } catch (e) {
            // If opening failed it will be handled here; don't let it bubble up to the outer handleMessage try/catch
            console.error('Could not open target for patch:', e);
            out.appendLine(`Could not open target for patch: ${String(e)}`);
            vscode.window.showErrorMessage(`Could not open file for patch: ${relPath}`);
            out.appendLine('EXIT handleApplyPatch (open error)');
            console.log('EXIT handleApplyPatch (open error)');
            return;
        }

        // 2. 解析 Diff
        const patches = parseDiffBlocks(diffContent);
        if (patches.length === 0) {
            vscode.window.showWarningMessage("Received patch command but found no valid blocks.");
            out.appendLine('EXIT handleApplyPatch (no patches)');
            console.log('EXIT handleApplyPatch (no patches)');
            return;
        }

        // 3. 逐个应用 (串行 await，保证坐标正确)
        for (const patch of patches) {
            await applySinglePatchAnimated(patch);
        }

        // 4. 保存
        const saved = await doc.save();
        sendAck();
        if (saved) {
            vscode.window.setStatusBarMessage(`Patch applied & saved: ${relPath}`, 3000);
        } else {
            // 如果自动保存失败（例如文件被占用），提示用户
            vscode.window.setStatusBarMessage(`Patch applied (Unsaved): ${relPath}`, 3000);
        }
        out.appendLine(`EXIT handleApplyPatch: ${relPath}`);
        console.log(`EXIT handleApplyPatch: ${relPath}`);
    }

    async function applySinglePatchAnimated(patch: CodePatch) {
        out.appendLine('ENTER applySinglePatchAnimated');
        console.log('ENTER applySinglePatchAnimated');
        if (!activeEditor) {
            out.appendLine('EXIT applySinglePatchAnimated (no active editor)');
            console.log('EXIT applySinglePatchAnimated (no active editor)');
            return;
        }
        const doc = activeEditor.document;
        const text = doc.getText();

        // --- A. 定位 ---
        // 简单定位：直接 indexOf (生产环境建议加 Fuzzy Match)
        // 简单处理 CRLF 问题
        const normText = text.replace(/\r\n/g, '\n');
        const normSearch = patch.search.replace(/\r\n/g, '\n').trim(); // trim 增加容错
        
        let idx = normText.indexOf(normSearch);
        
        if (idx === -1) {
            console.warn("Patch search block not found:", patch.search);
            out.appendLine(`Patch search block not found: ${patch.search}`);
            vscode.window.showWarningMessage(`Could not find code block to replace.`);
            out.appendLine('EXIT applySinglePatchAnimated (patch not found)');
            console.log('EXIT applySinglePatchAnimated (patch not found)');
            return;
        }

        const startPos = doc.positionAt(idx);
        const endPos = doc.positionAt(idx + normSearch.length);
        const range = new vscode.Range(startPos, endPos);

        // --- B. 动画：聚焦 & 变红 ---
        activeEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        activeEditor.setDecorations(deleteDec, [range]);
        
        // 停顿 600ms 让用户看到要删哪里
        await new Promise(r => setTimeout(r, 600));

        // --- C. 动作：删除 ---
        await activeEditor.edit(builder => {
            builder.delete(range);
        });
        activeEditor.setDecorations(deleteDec, []);

        // --- D. 动作：插入 (带绿色高亮) ---
        // 插入点就是 startPos
        await activeEditor.edit(builder => {
            builder.insert(startPos, patch.replace);
        });

        // 计算插入后的范围用于高亮
        const newTextLen = patch.replace.length;
        const newEndPos = doc.positionAt(idx + newTextLen);
        const newRange = new vscode.Range(startPos, newEndPos);

        activeEditor.setDecorations(insertDec, [newRange]);

        // 1秒后移除高亮
        setTimeout(() => {
            activeEditor?.setDecorations(insertDec, []);
            out.appendLine('EXIT applySinglePatchAnimated');
            console.log('EXIT applySinglePatchAnimated');
        }, 1000);
    }

    // --- 辅助：Diff 解析器 ---
    function parseDiffBlocks(diff: string): CodePatch[] {
        out.appendLine('ENTER parseDiffBlocks');
        console.log('ENTER parseDiffBlocks');
        const lines = diff.split(/\r?\n/);
        const blocks: CodePatch[] = [];
        let searchLines: string[] = [];
        let replaceLines: string[] = [];
        let state: 'IDLE' | 'SEARCH' | 'REPLACE' = 'IDLE';

        for (const line of lines) {
            const trim = line.trim(); // 简单处理
            
            if (line.includes('------- SEARCH')) {
                state = 'SEARCH';
                searchLines = [];
            } else if (line.includes('=======')) {
                if (state === 'SEARCH') {
                    state = 'REPLACE';
                    replaceLines = [];
                }
            } else if (line.includes('+++++++ REPLACE')) {
                if (state === 'REPLACE') {
                    blocks.push({
                        search: searchLines.join('\n'),
                        replace: replaceLines.join('\n')
                    });
                    state = 'IDLE';
                }
            } else {
                if (state === 'SEARCH') searchLines.push(line);
                else if (state === 'REPLACE') replaceLines.push(line);
            }
        }
        return blocks;
    }

    function resetQueue() {
        out.appendLine('ENTER resetQueue');
        console.log('ENTER resetQueue');
        lineQueue = [];
        isAiFinished = false;
        isConsuming = false;
        currentLineIndex = 0;
        if (activeEditor) {
            activeEditor.setDecorations(activeLineDec, []);
            activeEditor.setDecorations(fadedDec, []);
            activeEditor.setDecorations(deleteDec, []);
            activeEditor.setDecorations(insertDec, []);
        }
        out.appendLine('EXIT resetQueue');
        console.log('EXIT resetQueue');
    }
    async function finishLogic() {
        out.appendLine('ENTER finishLogic');
        console.log('ENTER finishLogic');
        if (!activeEditor) {
            out.appendLine('EXIT finishLogic (no active editor)');
            console.log('EXIT finishLogic (no active editor)');
            return;
        }
        
        // 1. 清理装饰器
        activeEditor.setDecorations(activeLineDec, []);
        activeEditor.setDecorations(fadedDec, []);
        
        // 2. 【关键】强制保存到硬盘
        try {
            const saved = await activeEditor.document.save();
            if (saved) {
                vscode.window.setStatusBarMessage('$(check) AI Edit Saved', 3000);
                 sendAck();
            } else {
                vscode.window.showWarningMessage('AI Edit completed but AUTO-SAVE failed. Please save manually.');
            }
        } catch (e) {
            console.error("Save failed:", e);
            out.appendLine(`Save failed: ${String(e)}`);
        }
        out.appendLine('EXIT finishLogic');
        console.log('EXIT finishLogic');
    }

    // --- 连接逻辑 ---
    function connect() {
        out.appendLine('ENTER connect');
        console.log('ENTER connect');
        if (ws) {
            try { ws.close(); } catch {}
        }
        console.log(`Connecting to ${wsUrl}`);
        out.appendLine(`Connecting to ${wsUrl}`);
        ws = new WebSocket(wsUrl!);

        ws.on('open', () => {
            vscode.window.setStatusBarMessage('$(plug) AI Agent Connected', 5000);
        });

        ws.on('message', (data) => {
            try {
                const json = JSON.parse(data.toString()) as EditorCommandMsg;
                handleMessage(json);
            } catch (e) {
                console.error("Parse error", e);
                out.appendLine(`Parse error: ${String(e)}`);
            }
        });

        ws.on('error', (e) => {
            console.error('WS Error', e);
            out.appendLine(`WS Error: ${String(e)}`);
            setTimeout(connect, 5000); // 自动重连
        });
        
        ws.on('close', () => {
            console.log('WS Closed');
            out.appendLine('WS Closed');
            setTimeout(connect, 5000);
        });
        out.appendLine('EXIT connect (setup complete)');
        console.log('EXIT connect (setup complete)');
    }

    connect();
    context.subscriptions.push(vscode.commands.registerCommand('cline-sim.connect', connect));
}

export function deactivate() {}