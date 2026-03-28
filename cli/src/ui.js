const { ANSI } = require('./constants');

function log(message = '') {
  process.stdout.write(`${message}\n`);
}

function logError(message) {
  process.stderr.write(`${message}\n`);
}

function supportsRichCliUi() {
  return Boolean(process.stdout.isTTY);
}

function stripAnsi(text) {
  return String(text).replace(/\x1B\[[0-9;]*m/g, '');
}

function getCharacterVisualWidth(character) {
  if (!character) {
    return 0;
  }

  if (/[\u0300-\u036f\uFE0E\uFE0F]/u.test(character)) {
    return 0;
  }

  if (/\p{Extended_Pictographic}/u.test(character)) {
    return 2;
  }

  const codePoint = character.codePointAt(0);
  if (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  ) {
    return 2;
  }

  return 1;
}

function getVisualWidth(text) {
  return Array.from(stripAnsi(text)).reduce((sum, character) => sum + getCharacterVisualWidth(character), 0);
}

function padVisual(text, width) {
  return `${text}${' '.repeat(Math.max(width - getVisualWidth(text), 0))}`;
}

function getCliContentWidth() {
  const columns = Number.parseInt(process.stdout.columns, 10);
  if (!Number.isFinite(columns) || columns <= 0) {
    return 52;
  }

  return Math.max(20, Math.min(columns - 6, 52));
}

function wrapPlainText(text, width) {
  const normalized = String(text).trim();
  if (!normalized) {
    return [''];
  }

  const words = normalized.split(/\s+/);
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
      continue;
    }

    if (getVisualWidth(`${currentLine} ${word}`) <= width) {
      currentLine = `${currentLine} ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = word;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  return lines;
}

function wrapPanelLine(line, width) {
  if (getVisualWidth(line) <= width) {
    return [line];
  }

  return wrapPlainText(stripAnsi(line), width);
}

function getToneColor(tone = 'cyan') {
  if (tone === 'green') {
    return ANSI.green;
  }

  if (tone === 'yellow') {
    return ANSI.yellow;
  }

  if (tone === 'red') {
    return ANSI.red;
  }

  return ANSI.brightCyan;
}

function styleText(text, ...codes) {
  if (!supportsRichCliUi()) {
    return text;
  }

  return `${codes.join('')}${text}${ANSI.reset}`;
}

function formatStatusToken(status) {
  const normalized = String(status).toLowerCase();
  const appearance = {
    ok: { label: 'OK', color: ANSI.green },
    listening: { label: 'LIVE', color: ANSI.green },
    running: { label: 'LIVE', color: ANSI.green },
    written: { label: 'DONE', color: ANSI.green },
    ready: { label: 'READY', color: ANSI.green },
    starting: { label: 'START', color: ANSI.brightCyan },
    skipped: { label: 'SKIP', color: ANSI.gray },
    missing: { label: 'MISS', color: ANSI.red },
    error: { label: 'ERROR', color: ANSI.red },
    failed: { label: 'ERROR', color: ANSI.red },
    'not running': { label: 'IDLE', color: ANSI.yellow },
    warning: { label: 'WARN', color: ANSI.yellow },
  }[normalized] || { label: status, color: ANSI.gray };

  if (!supportsRichCliUi()) {
    return appearance.label.toLowerCase();
  }

  return `${styleText('●', appearance.color)} ${styleText(appearance.label, ANSI.bold, appearance.color)}`;
}

function formatStatusLine(label, status, detail = '', width = 28) {
  const renderedLabel = supportsRichCliUi() ? styleText(label, ANSI.bold) : label;
  const renderedDetail = detail
    ? supportsRichCliUi()
      ? styleText(detail, ANSI.dim)
      : detail
    : '';

  return `${padVisual(renderedLabel, width)} ${formatStatusToken(status)}${detail ? ` ${renderedDetail}` : ''}`;
}

function logPanel(title, lines = [], options = {}) {
  const normalizedLines = lines
    .filter((line) => line !== undefined && line !== null)
    .map((line) => String(line));

  if (!supportsRichCliUi()) {
    if (title) {
      log(title);
    }

    for (const line of normalizedLines) {
      log(`  ${stripAnsi(line)}`);
    }

    log('');
    return;
  }

  const toneColor = getToneColor(options.tone);
  const width = getCliContentWidth();
  const wrappedLines = normalizedLines.flatMap((line) => wrapPanelLine(line, width));
  const titleWidth = getVisualWidth(title);
  const railTailWidth = Math.max(6, width - titleWidth - 1);
  const closeLeft = options.continueRail !== false ? '├' : '╰';

  log(`${styleText('◇', ANSI.bold, toneColor)}  ${styleText(title, ANSI.bold)} ${styleText(`${'─'.repeat(railTailWidth)}╮`, ANSI.bold, toneColor)}`);
  log(`${styleText('│', ANSI.bold, toneColor)} ${' '.repeat(width)} ${styleText('│', ANSI.bold, toneColor)}`);

  for (const line of wrappedLines) {
    log(`${styleText('│', ANSI.bold, toneColor)} ${padVisual(line, width)} ${styleText('│', ANSI.bold, toneColor)}`);
  }

  log(`${styleText('│', ANSI.bold, toneColor)} ${' '.repeat(width)} ${styleText('│', ANSI.bold, toneColor)}`);
  log(`${styleText(closeLeft, ANSI.bold, toneColor)}${styleText('─'.repeat(width + 2), toneColor)}${styleText('╯', ANSI.bold, toneColor)}`);

  if (options.continueRail !== false) {
    log(styleText('│', ANSI.bold, toneColor));
  }
}

function logCliHeader(icon, title, subtitle = '') {
  const heading = icon ? `${icon} ${title}` : title;

  if (!supportsRichCliUi()) {
    log(heading);
    if (subtitle) {
      log(`  ${subtitle}`);
    }
    log('');
    return;
  }

  log(styleText(heading, ANSI.bold, ANSI.brightCyan));
  if (subtitle) {
    for (const line of wrapPlainText(subtitle, getCliContentWidth())) {
      log(`   ${styleText(line, ANSI.dim)}`);
    }
  }
  log('');
}

function logCliFlowStart(label, tone = 'cyan') {
  if (!supportsRichCliUi()) {
    log(label);
    log('');
    return;
  }

  const toneColor = getToneColor(tone);
  log(`${styleText('┌', ANSI.bold, toneColor)}  ${styleText(label, ANSI.bold)}`);
  log(styleText('│', ANSI.bold, toneColor));
}

function logCliFlowEnd() {
  if (!supportsRichCliUi()) {
    return;
  }

  log('');
}

function logCommandList(title, commands, options = {}) {
  const panelWidth = getCliContentWidth();
  const descriptionFirstPrefix = '  ↳ ';
  const descriptionContinuationPrefix = '    ';
  const descriptionWidth = Math.max(panelWidth - getVisualWidth(descriptionFirstPrefix), 12);
  const lines = [];

  for (const [index, { name, description }] of commands.entries()) {
    lines.push(supportsRichCliUi() ? styleText(name, ANSI.bold, ANSI.brightCyan) : name);

    const wrappedDescription = wrapPlainText(description, descriptionWidth);
    for (const [lineIndex, line] of wrappedDescription.entries()) {
      const prefix = lineIndex === 0 ? descriptionFirstPrefix : descriptionContinuationPrefix;
      lines.push(
        supportsRichCliUi()
          ? `${prefix}${styleText(line, ANSI.dim)}`
          : `${prefix}${line}`,
      );
    }

    if (index < commands.length - 1) {
      lines.push('');
    }
  }

  logPanel(title, lines, options);
}

function logStepList(title, steps, options = {}) {
  const lines = steps.map((step, index) => `${index + 1}. ${step}`);
  logPanel(title, lines, options);
}

function logKeyValuePanel(title, entries, options = {}) {
  const width = Math.max(...entries.map((entry) => entry.label.length), 12);
  const lines = entries.map(({ label, value }) => {
    const renderedLabel = supportsRichCliUi()
      ? styleText(padVisual(label, width), ANSI.bold)
      : padVisual(label, width);
    return `${renderedLabel} ${value}`;
  });

  logPanel(title, lines, options);
}

function logStatusPanel(title, items, options = {}) {
  const width = Math.max(22, ...items.map((item) => item.label.length));
  const lines = items.map((item) => formatStatusLine(item.label, item.status, item.detail || '', width));
  logPanel(title, lines, options);
}

function logOnboardingSection(title, subtitle = '', options = {}) {
  logPanel(title, subtitle ? [subtitle] : [], { tone: 'cyan', ...options });
}

function printStatus(label, status, detail = '') {
  log(`  ${formatStatusLine(label, status, detail, 24)}`);
}

function fail(message, exitCode = 1) {
  if (supportsRichCliUi()) {
    logPanel('Command failed', [styleText(message, ANSI.bold, ANSI.red)], { tone: 'red', continueRail: false });
  } else {
    logError(message);
  }
  process.exit(exitCode);
}

module.exports = {
  ANSI,
  log,
  logError,
  supportsRichCliUi,
  stripAnsi,
  getVisualWidth,
  padVisual,
  getCliContentWidth,
  wrapPlainText,
  wrapPanelLine,
  getToneColor,
  styleText,
  formatStatusToken,
  formatStatusLine,
  logPanel,
  logCliHeader,
  logCliFlowStart,
  logCliFlowEnd,
  logCommandList,
  logStepList,
  logKeyValuePanel,
  logStatusPanel,
  logOnboardingSection,
  printStatus,
  fail,
};
