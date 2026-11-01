function classifyPayload(payload) {
    let parsed;
    try {
        parsed = JSON.parse(String(payload));
    } catch (error) {
        return { kind: 'non-json', label: 'non-json' };
    }

    if (!parsed || typeof parsed !== 'object') return { kind: 'scalar', label: 'scalar' };
    if (parsed.access_token) return { kind: 'token', label: 'auth(token)' };
    if (parsed.fp) return { kind: 'fp', label: 'fp' };
    if (parsed.ticket) return { kind: 'ticket', label: 'ticket' };
    if ('text' in parsed) return { kind: 'text', label: `text(${String(parsed.text || '').length}ch)` };

    if (String(parsed.code) === '1' && String(parsed.evil_level) === '0') {
        return { kind: 'captcha-success', label: 'code=1 evil_level=0' };
    }
    if (String(parsed.code) === '15') return { kind: 'captcha-failure', label: 'code=15 decrypt-fail' };

    const bits = [];
    if (parsed.status) bits.push(`status=${parsed.status}`);
    if (parsed.code !== undefined) bits.push(`code=${parsed.code}`);
    if (parsed.evil_level !== undefined) bits.push(`evil_level=${parsed.evil_level}`);
    if (parsed.availableUses !== undefined) bits.push(`uses=${parsed.availableUses}`);
    if (parsed.confidence !== undefined) bits.push(`confidence=${parsed.confidence}`);
    if (parsed.msg) bits.push(`msg=${JSON.stringify(String(parsed.msg).slice(0, 40))}`);
    return { kind: 'other-response', label: bits.length ? bits.join(' ') : 'other' };
}

function analyzeVerifiedFlow(events) {
    const ordered = [...events].sort((a, b) => a.timeMs - b.timeMs);
    const tickets = ordered.filter(event => event.direction === 'send' && event.kind === 'ticket');
    const successes = ordered.filter(event => event.direction === 'recv' && event.kind === 'captcha-success');
    const texts = ordered.filter(event => event.direction === 'send' && event.kind === 'text');

    for (const ticket of tickets) {
        const success = successes.find(event =>
            event.requestId === ticket.requestId && event.timeMs >= ticket.timeMs
        );
        if (!success) continue;

        const text = texts.find(event =>
            event.requestId === ticket.requestId && event.timeMs >= success.timeMs
        );
        if (text) return { status: 'verified-text-same-socket', ticket, success, text };
    }

    const firstTicket = tickets[0] || null;
    const firstSuccess = successes[0] || null;
    const firstText = texts[0] || null;

    if (!firstTicket) return { status: 'no-ticket' };
    if (!firstSuccess) return { status: 'no-captcha-success' };
    if (!firstText) return { status: 'no-text-after-success' };
    if (firstTicket.requestId !== firstSuccess.requestId) {
        return { status: 'captcha-success-on-different-socket', ticket: firstTicket, success: firstSuccess, text: firstText };
    }
    if (firstText.timeMs < firstSuccess.timeMs) {
        return { status: 'text-before-captcha-success', ticket: firstTicket, success: firstSuccess, text: firstText };
    }
    return { status: 'text-on-different-socket', ticket: firstTicket, success: firstSuccess, text: firstText };
}

module.exports = { classifyPayload, analyzeVerifiedFlow };
