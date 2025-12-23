import * as vscode from 'vscode';
import WebSocket from 'ws';

// --- 1. 定义新的协议类型 ---
interface EditorCommandMsg {
    type: 'EDITOR_COMMAND';
    nonce?: string;
    command: 'WRITE_FILE' | 'APPLY_PATCH'| 'OPEN_FILE' | 'SHOW_MODIFICATION';
    payload: {
        filePath: string;
        content?: string; // 用于 WRITE_FILE
        diff?: string;    // 用于 APPLY_PATCH
        mode?: 'overwrite' | 'diff';
        anchor?: string; // 用于定位的文本片段
        type?: 'overwrite' | 'patch';
    };
}

const modificationDec = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(50, 205, 50, 0.3)', // 亮绿色背景
    isWholeLine: true,
    overviewRulerColor: 'green',
    overviewRulerLane: vscode.OverviewRulerLane.Right
});

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

/**
 * 辅助函数：打开并显示文件
 * 兼容处理相对路径、绝对路径和完整 URI
 */
async function openFileInEditor(filePath: string): Promise<vscode.TextEditor | undefined> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    if (!wsFolder) {
        vscode.window.showErrorMessage('无法打开文件：当前没有打开的工作区。');
        return undefined;
    }

    let targetUri: vscode.Uri;

    try {
        // 1. 路径解析策略
        // 如果包含协议头 (如 vscode-remote://, file://, http://)，直接解析为 URI
        if (filePath.includes('://') || filePath.startsWith('file:') || filePath.startsWith('vscode-')) {
            targetUri = vscode.Uri.parse(filePath);
        } 
        else {
            // 处理相对路径/绝对路径
            // 移除开头的斜杠或反斜杠，确保 joinPath 正确工作
            let cleanPath = filePath.replace(/^[\\\/]+/, '');
            
            // 可选：如果你的后端返回的路径包含工作区根目录名（例如 /workspace/src/main.py），
            // 而 VSCode 打开的根目录就是 /workspace，你可能需要在这里切片。
            // const wsPathName = wsFolder.name; // e.g. "workspace"
            // if (cleanPath.startsWith(wsPathName + '/')) {
            //     cleanPath = cleanPath.slice(wsPathName.length + 1);
            // }

            targetUri = vscode.Uri.joinPath(wsFolder.uri, cleanPath);
        }

        // 2. 尝试打开文档
        // openTextDocument 会加载文档对象 (TextDocument)
        const doc = await vscode.workspace.openTextDocument(targetUri);

        // 3. 在编辑器中显示
        // viewColumn: Active 表示在当前活动列打开
        // preview: false 表示不要以“预览模式”（斜体标题）打开，防止点击其他文件时被关闭
        const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: vscode.ViewColumn.Active,
            preview: false 
        });

        return editor;

    } catch (e) {
        console.error(`[Open File Error] Path: ${filePath}`, e);
        
        // 尝试友好的错误提示
        if ((e as any)?.code === 'FileNotFound') {
            vscode.window.showErrorMessage(`无法打开文件：找不到文件 ${filePath}`);
        } else {
            vscode.window.showErrorMessage(`打开文件失败: ${e}`);
        }
        
        return undefined;
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
            } else if (command === 'OPEN_FILE') {
                out.appendLine('handleMessage: OPEN_FILE');
                
                // 1. 立即 ACK (因为只是打开文件，很快)
                sendAck();
                
                // 2. 打开文件
                await openAndShowFile(payload.filePath);
            } else if (msg.command === 'SHOW_MODIFICATION') {
                await showModificationEffect(
                    msg.payload.filePath, 
                    msg.payload.anchor || "", 
                    msg.payload.type!
                );
            }

            out.appendLine('EXIT handleMessage');
            console.log('EXIT handleMessage');
        } catch (e) {
            console.error("Error handling message:", e);
            out.appendLine(`Error handling message: ${String(e)}`);
            vscode.window.showErrorMessage(`Agent Error: ${e}`);
            out.appendLine('EXIT handleMessage (error)');
            console.log('EXIT ha ndleMessage (error)');
        }
    }

    // 核心视觉效果函数
    async function showModificationEffect(relPath: string, anchor: string, type: 'overwrite' | 'patch') {
        // 1. 打开并显示文件 (复用之前的路径解析逻辑)
        const editor = await openFileInEditor(relPath); 
        if (!editor) return;

        const doc = editor.document;
        let rangeToHighlight: vscode.Range;

        // 2. 确定高亮范围
        if (type === 'overwrite' || !anchor) {
            // 全量覆盖：高亮前 20 行，或者全文
            rangeToHighlight = new vscode.Range(0, 0, Math.min(doc.lineCount, 20), 0);
        } else {
            // Patch 修改：在文档中搜索锚点文本
            const text = doc.getText();
            // 简单的字符串查找，定位到 Agent 修改的地方
            const idx = text.indexOf(anchor);
            if (idx !== -1) {
                const startPos = doc.positionAt(idx);
                const endPos = doc.positionAt(idx + anchor.length);
                // 扩展一下高亮范围，让视觉更明显
                rangeToHighlight = new vscode.Range(startPos, endPos);
            } else {
                // 找不到锚点（可能格式化变了），回退到高亮文件末尾或开头
                rangeToHighlight = new vscode.Range(doc.lineCount - 5, 0, doc.lineCount, 0);
            }
        }

        // 3. 滚动并高亮
        editor.revealRange(rangeToHighlight, vscode.TextEditorRevealType.InCenter);
        
        // 应用高亮
        editor.setDecorations(modificationDec, [rangeToHighlight]);

        // 4. 2秒后淡出/移除高亮
        setTimeout(() => {
            editor.setDecorations(modificationDec, []);
        }, 2000);
        
        // 可选：状态栏提示
        vscode.window.setStatusBarMessage(`$(sparkle) Agent updated: ${relPath}`, 4000);
    }

    async function openAndShowFile(relPath: string) {
        const wsFolder = vscode.workspace.workspaceFolders?.[0];
        if (!wsFolder) return;

        // 路径解析逻辑 (复用之前的)
        let targetUri: vscode.Uri;
        try {
             if (relPath.startsWith('vscode-') || relPath.startsWith('vscode:') || relPath.startsWith('file:') || relPath.startsWith('http')) {
                targetUri = vscode.Uri.parse(relPath);
            } else {
                const wsPath = wsFolder.uri.path || '';
                let normalized = relPath;
                if (normalized.startsWith(wsPath)) {
                    normalized = normalized.slice(wsPath.length);
                }
                normalized = normalized.replace(/^\/+/, '');
                targetUri = vscode.Uri.joinPath(wsFolder.uri, normalized);
            }
        } catch(e) { return; }

        // 打开文档
        try {
            const doc = await vscode.workspace.openTextDocument(targetUri);
            await vscode.window.showTextDocument(doc);
            
            // 可选：给个提示
            vscode.window.setStatusBarMessage(`$(check) File updated by Agent: ${relPath}`, 3000);
        } catch (e) {
            console.error("Failed to open file:", e);
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
        // Normalize incoming path: support relative paths, absolute paths that include the workspace path,
        // and full vscode-remote/file URIs passed from the agent.
        let targetUri: vscode.Uri;
        try {
            if (relPath.startsWith('vscode-') || relPath.startsWith('vscode:') || relPath.startsWith('file:') || relPath.startsWith('http')) {
                targetUri = vscode.Uri.parse(relPath);
            } else {
                const wsPath = wsFolder.uri.path || '';
                let normalized = relPath;
                if (normalized.startsWith(wsPath)) {
                    normalized = normalized.slice(wsPath.length);
                }
                normalized = normalized.replace(/^\/+/, '');
                targetUri = vscode.Uri.joinPath(wsFolder.uri, normalized);
            }
        } catch (e) {
            console.error('Could not resolve targetUri for write:', e);
            out.appendLine(`Could not resolve targetUri for write: ${String(e)}`);
            out.appendLine('EXIT prepareEditorForWrite (resolve error)');
            console.log('EXIT prepareEditorForWrite (resolve error)');
            return;
        }
        out.appendLine(`Resolved targetUri: ${targetUri.toString()}`);
        console.log(`Resolved targetUri: ${targetUri.toString()}`);

        // 1. 准备文件 (创建或覆盖)
        // 这一步确保文件存在
        const wsEdit = new vscode.WorkspaceEdit();
        wsEdit.createFile(targetUri, { overwrite: true, ignoreIfExists: true });
        await vscode.workspace.applyEdit(wsEdit);

        // 2. 打开编辑器
        // 准备 Diff 视图所需的左侧 URI
        const leftUri = vscode.Uri.parse(`${SCHEME}:${targetUri.path}`);
        // 填充左侧 Provider 的内容 (Snapshot)
        try {
            const bytes = await vscode.workspace.fs.readFile(targetUri);
            originalContentMap.set(targetUri.path, new TextDecoder().decode(bytes));
        } catch { 
            originalContentMap.set(targetUri.path, ""); 
        }
        // 3. 打开视图
        await vscode.commands.executeCommand('vscode.diff', leftUri, targetUri, `AI Editing: ${relPath}`);
        
        activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            out.appendLine('EXIT prepareEditorForWrite (no active editor)');
            console.log('EXIT prepareEditorForWrite (no active editor)');
            return;
        }

        // 3.直接全量替换内容，不搞花里胡哨的动画
        const doc = activeEditor.document;
        const fullRange = new vscode.Range(0, 0, doc.lineCount, 0);
        
        const success = await activeEditor.edit(editBuilder => {
            // 先清空，再写入。这种原子操作非常快 (毫秒级)
            editBuilder.replace(fullRange, fullContent);
        });

        if (success) {
            // 4. 视觉反馈：给全文或前 50 行加上绿色高亮，提示用户这是新生成的
            const highlightRange = new vscode.Range(0, 0, Math.min(doc.lineCount, 50), 0);
            activeEditor.setDecorations(insertDec, [highlightRange]);
            
            // 1.5秒后淡出高亮
            setTimeout(() => {
                activeEditor?.setDecorations(insertDec, []);
            }, 1500);

            // 5. 滚动到顶部
            activeEditor.revealRange(new vscode.Range(0,0,0,0), vscode.TextEditorRevealType.AtTop);
        }

        // 6. 【关键】强制保存并发送 ACK
        // 只有保存成功了，硬盘上才有数据，Agent 下一步读取才不会空
        await finishLogic(); 
        
        out.appendLine('EXIT prepareEditorForWrite (Fast Mode)');
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

        const BATCH_SIZE = 50; // 每次处理 50 行
        let processedInBatch = 0;

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

                // 2. 动效 (减少高亮频率，避免闪烁且提高性能)
                // 只有在每个 Batch 结束时才滚动和高亮
                currentLineIndex++;
                processedInBatch++;

                if (processedInBatch >= BATCH_SIZE || lineQueue.length === 0) {
                    const range = new vscode.Range(currentLineIndex - 1, 0, currentLineIndex - 1, 0);
                    activeEditor.revealRange(range, vscode.TextEditorRevealType.InCenter);
                    activeEditor.setDecorations(activeLineDec, [range]);
                    
                    // 重置计数器并微小延时让 UI 刷新
                    processedInBatch = 0;
                    await new Promise(r => setTimeout(r, 5)); // 延迟降为 5ms 且每50行才触发一次
                }

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