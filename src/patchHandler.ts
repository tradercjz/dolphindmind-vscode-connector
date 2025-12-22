import * as vscode from 'vscode';
import { parseDiffBlocks, CodePatch } from './patchUtils';

// 定义装饰器样式 (红色删除背景，绿色新增背景)
const deleteDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(255, 0, 0, 0.2)',
    isWholeLine: true,
});

const insertDecoration = vscode.window.createTextEditorDecorationType({
    backgroundColor: 'rgba(0, 255, 0, 0.2)',
    isWholeLine: true,
});

/**
 * 主入口：处理 APPLY_PATCH 指令
 */
export async function handleApplyPatch(
    payload: { filePath: string; diff: string }
) {
    const { filePath, diff } = payload;

    // 1. 解析 Diff
    const patches = parseDiffBlocks(diff);
    if (patches.length === 0) {
        vscode.window.showWarningMessage('收到了 Patch 指令，但无法解析出有效的修改块。');
        return;
    }

    // 2. 打开或激活目标文件
    const editor = await openFileInEditor(filePath);
    if (!editor) return;

    // 3. 逐个应用 Patch (必须串行执行，否则坐标会乱)
    for (const patch of patches) {
        const success = await applySinglePatchAnimated(editor, patch);
        if (!success) {
            vscode.window.showErrorMessage(`无法找到代码块:\n${patch.search.substring(0, 50)}...`);
            // 可以选择中断，或者继续尝试下一个
            break; 
        }
    }
    
    // 4. 保存文件 (对应后端的 "写入Pod")
    await editor.document.save();
}

/**
 * 辅助：打开文件
 */
async function openFileInEditor(relPath: string): Promise<vscode.TextEditor | undefined> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) return undefined;

    // 简单拼接路径，实际可能需要更复杂的路径解析
    const uri = vscode.Uri.joinPath(workspaceFolders[0].uri, relPath);
    
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        return await vscode.window.showTextDocument(doc);
    } catch (e) {
        vscode.window.showErrorMessage(`无法打开文件: ${relPath}`);
        return undefined;
    }
}

/**
 * 核心：应用单个 Patch 并带动画
 */
async function applySinglePatchAnimated(
    editor: vscode.TextEditor, 
    patch: CodePatch
): Promise<boolean> {
    const document = editor.document;
    const fullText = document.getText();
    
    // 1. 定位旧代码
    // 注意：这里需要处理换行符差异 (CRLF vs LF)
    // 简单策略：将 search 文本和文档文本都标准化为 \n 进行查找
    const normalizedDocText = fullText.replace(/\r\n/g, '\n');
    const normalizedSearch = patch.search.replace(/\r\n/g, '\n');
    
    const startIndex = normalizedDocText.indexOf(normalizedSearch);
    
    if (startIndex === -1) {
        // 尝试容错：去除首尾空行再找一次
        const trimmedSearch = normalizedSearch.trim();
        const trimmedIndex = normalizedDocText.indexOf(trimmedSearch);
        if (trimmedIndex === -1) return false;
        
        // 如果 Trim 后找到了，我们需要反推在原文档中的 Range
        // 这里简化处理，直接用找到的索引
        return executeReplacement(editor, document.positionAt(trimmedIndex), trimmedSearch.length, patch.replace);
    }

    return executeReplacement(editor, document.positionAt(startIndex), normalizedSearch.length, patch.replace);
}

/**
 * 执行替换动作
 */
async function executeReplacement(
    editor: vscode.TextEditor, 
    startPos: vscode.Position, 
    length: number, 
    newText: string
): Promise<boolean> {
    const document = editor.document;
    const endPos = document.positionAt(document.offsetAt(startPos) + length);
    const range = new vscode.Range(startPos, endPos);

    // 1. 滚动到可见区域
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    // 2. 视觉反馈：标记要删除的区域 (红色)
    editor.setDecorations(deleteDecoration, [range]);
    
    // 停顿 500ms 让用户看清要删什么
    await new Promise(r => setTimeout(r, 500));

    // 3. 删除旧代码
    await editor.edit(editBuilder => {
        editBuilder.delete(range);
    });
    editor.setDecorations(deleteDecoration, []); // 清除红框

    // 4. 流式写入新代码 (打字机效果)
    // 为了性能，我们不按字符写，按行写
    const newLines = newText.split('\n');
    let currentLine = startPos.line;
    
    // 插入一个空行作为起始点
    // await editor.edit(b => b.insert(startPos, "")); 

    // 既然 Python 后端是整块发过来的，其实前端直接整块写入体验也很好
    // 如果非要流式，可以拆分 edit。这里演示整块写入 + 绿色高亮
    
    await editor.edit(editBuilder => {
        editBuilder.insert(startPos, newText);
    });

    // 计算新插入的范围
    const newLength = newText.length;
    const newEndPos = document.positionAt(document.offsetAt(startPos) + newLength);
    const newRange = new vscode.Range(startPos, newEndPos);

    // 5. 视觉反馈：标记新增区域 (绿色)
    editor.setDecorations(insertDecoration, [newRange]);

    // 1秒后清除绿色高亮
    setTimeout(() => {
        editor.setDecorations(insertDecoration, []);
    }, 1000);

    return true;
}