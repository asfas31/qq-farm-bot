export {};
/**
 * 统一的推送卡片格式。所有 QQ 机器人出站消息都走这里生成 Markdown 卡片，
 * 纯文本只是 Markdown 权限不可用时的降级副本。
 */

const TYPE_META: Record<string, { icon: string, heading: string }> = {
    offline: { icon: '⚠️', heading: '账号下线提醒' },
    mysteryArrival: { icon: '🎁', heading: '神秘商人到访' },
    mysteryPurchase: { icon: '🛒', heading: '神秘商人购买' },
    test: { icon: '📢', heading: '通知测试' },
};

function timestamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 生成一份卡片消息。title/content 来自原有提醒逻辑，保持向后兼容；
 * type 决定图标与标题，没有 match 时用通用喇叭图标。
 */
function buildCard(input: { title: string, content: string, type?: string }): { title: string, content: string, markdown: string } {
    const meta = TYPE_META[String(input.type || '')] || { icon: '📢', heading: '' };
    const rawTitle = String(input.title || '').trim();
    const rawContent = String(input.content || '').trim();
    // 旧标题形如「账号下线提醒 112」，去掉已出现在标题里的重复前缀。
    const heading = meta.heading && rawTitle.startsWith(meta.heading)
        ? rawTitle.slice(meta.heading.length).trim()
        : rawTitle;
    const title = `${meta.icon} ${meta.heading || '通知'}${heading ? ` · ${heading}` : ''}`;
    const lines = rawContent.split('\n').map(line => line.trim()).filter(Boolean);
    const time = timestamp();
    const quote = lines.map(line => (line.startsWith('>') ? line : `> ${line}`)).join('\n');
    const markdown = [
        `## ${title}`,
        '',
        quote,
        '',
        '---',
        `*${time}*`,
    ].join('\n');
    const content = [title, '', ...lines, '', `时间 ${time}`].join('\n');
    return { title, content, markdown };
}

module.exports = { buildCard };
