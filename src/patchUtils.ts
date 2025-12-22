/**
 * 结构化的 Patch 对象
 */
export interface CodePatch {
    search: string;
    replace: string;
}

/**
 * 解析后端发来的自定义 Diff 格式
 * Format:
 * ------- SEARCH
 * [content]
 * =======
 * [new content]
 * +++++++ REPLACE
 */
export function parseDiffBlocks(diffContent: string): CodePatch[] {
    // 兼容各种换行符
    const lines = diffContent.split(/\r?\n/);
    const blocks: CodePatch[] = [];
    
    let currentSearch: string[] = [];
    let currentReplace: string[] = [];
    
    // 状态机: 'IDLE' | 'SEARCHING' | 'REPLACING'
    let state = 'IDLE'; 

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed === '------- SEARCH') {
            state = 'SEARCHING';
            currentSearch = [];
        } 
        else if (trimmed === '=======') {
            // 只有在搜索状态下遇到分割线才切换
            if (state === 'SEARCHING') {
                state = 'REPLACING';
                currentReplace = [];
            }
        } 
        else if (trimmed === '+++++++ REPLACE') {
            // 结束当前块，存入结果
            if (state === 'REPLACING') {
                blocks.push({
                    search: currentSearch.join('\n'),
                    replace: currentReplace.join('\n')
                });
                state = 'IDLE';
            }
        } 
        else {
            // 根据状态累积内容
            if (state === 'SEARCHING') {
                currentSearch.push(line);
            } else if (state === 'REPLACING') {
                currentReplace.push(line);
            }
        }
    }

    return blocks;
}