const readline = require('node:readline');
const {
  ANSI,
  log,
  logError,
  styleText,
  getVisualWidth,
  padVisual,
  getCliContentWidth,
  wrapPanelLine,
} = require('./render');

function supportsRichPromptUi(rl) {
  const input = rl.input ?? process.stdin;
  const output = rl.output ?? process.stdout;
  return Boolean(input?.isTTY && output?.isTTY);
}

function getPromptInputPrefix(rl) {
  if (!supportsRichPromptUi(rl)) {
    return '> ';
  }

  return `${styleText('  ›', ANSI.bold, ANSI.brightCyan)} `;
}

function logPromptError(message) {
  logError(styleText(message, ANSI.bold, ANSI.red));
}

function getPromptPanelWidth() {
  return getCliContentWidth();
}

function shouldMaskPromptValue(label, options = {}) {
  if (typeof options.maskValue === 'boolean') {
    return options.maskValue;
  }

  return /api key/i.test(label);
}

function formatPromptConfirmation(label, value, options = {}) {
  const isMasked = shouldMaskPromptValue(label, options);
  const hasValue = value !== undefined && value !== null && String(value).length > 0;
  const renderedValue = isMasked
    ? hasValue
      ? 'saved'
      : 'left empty'
    : hasValue
      ? String(value)
      : 'left empty';

  return `  ${styleText('✓', ANSI.green)} ${styleText(label, ANSI.bold)} ${styleText('→', ANSI.dim)} ${styleText(renderedValue, ANSI.bold, ANSI.brightCyan)}`;
}

function clearLastInteractiveLine(output) {
  readline.moveCursor(output, 0, -1);
  readline.cursorTo(output, 0);
  readline.clearLine(output, 0);
}

function renderPromptPanel(rl, title, options = {}) {
  if (!supportsRichPromptUi(rl)) {
    return;
  }

  const metaLines = [];
  if (options.hint) {
    metaLines.push(styleText(options.hint, ANSI.dim));
  }

  if (options.defaultValue) {
    metaLines.push(
      `${styleText('default', ANSI.gray)} ${styleText(String(options.defaultValue), ANSI.bold)}`,
    );
  } else if (options.allowEmpty) {
    metaLines.push(styleText('Optional — press Enter to leave it empty.', ANSI.dim));
  }

  if (options.validationHint) {
    metaLines.push(`${styleText('format', ANSI.gray)} ${options.validationHint}`);
  }

  if (options.keepDefaultHint && options.defaultValue) {
    metaLines.push(styleText('Press Enter to keep the current value.', ANSI.dim));
  }

  const innerWidth = getPromptPanelWidth();
  const wrappedMetaLines = metaLines.flatMap((line) => wrapPanelLine(line, innerWidth));

  log(styleText(`  ╭${'─'.repeat(innerWidth + 2)}╮`, ANSI.bold, ANSI.brightCyan));
  log(styleText(`  │ ${padVisual(title, innerWidth)} │`, ANSI.bold, ANSI.brightCyan));

  if (wrappedMetaLines.length > 0) {
    log(styleText(`  ├${'─'.repeat(innerWidth + 2)}┤`, ANSI.bold, ANSI.brightCyan));
    for (const line of wrappedMetaLines) {
      log(`${styleText('  │ ', ANSI.bold, ANSI.brightCyan)}${padVisual(line, innerWidth)}${styleText(' │', ANSI.bold, ANSI.brightCyan)}`);
    }
  }

  log(styleText(`  ╰${'─'.repeat(innerWidth + 2)}╯`, ANSI.bold, ANSI.brightCyan));
}

async function promptValue(rl, label, defaultValue, options = {}) {
  while (true) {
    const output = rl.output ?? process.stdout;

    if (supportsRichPromptUi(rl)) {
      renderPromptPanel(rl, label, {
        defaultValue,
        hint: options.hint,
        allowEmpty: options.allowEmpty,
        validationHint: options.validationHint,
        keepDefaultHint: options.keepDefaultHint ?? true,
      });
    }

    const defaultSuffix = !supportsRichPromptUi(rl) && defaultValue ? ` [${defaultValue}]` : '';
    const promptLabel = supportsRichPromptUi(rl) ? getPromptInputPrefix(rl) : `${label}${defaultSuffix}: `;
    const answer = await rl.question(promptLabel);
    const normalized = answer.trim();
    const value = normalized.length === 0 ? defaultValue ?? '' : normalized;

    if (typeof options.validate === 'function') {
      const validationError = options.validate(value);
      if (validationError) {
        logPromptError(validationError);
        if (supportsRichPromptUi(rl)) {
          log('');
        }
        continue;
      }
    }

    if (supportsRichPromptUi(rl)) {
      clearLastInteractiveLine(output);
      log(formatPromptConfirmation(label, value, options));
      log('');
    }

    return value;
  }
}

async function promptChoiceWithHotkeys(rl, label, options, defaultValue, promptOptions = {}) {
  const input = rl.input ?? process.stdin;
  const output = rl.output ?? process.stdout;

  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return null;
  }

  const defaultIndex = options.findIndex((option) => option.value === defaultValue);
  const resolvedDefaultIndex = defaultIndex >= 0 ? defaultIndex : 0;
  let activeIndex = resolvedDefaultIndex;
  let renderedLines = 0;
  let hasRenderAnchor = false;
  const wasRawMode = input.isRaw === true;
  const hotkeyHint = `↑/↓ move • Enter select • 1-${options.length} quick choose`;

  const saveRenderAnchor = () => {
    if (!hasRenderAnchor) {
      output.write('\x1B[s');
      hasRenderAnchor = true;
    }
  };

  const restoreRenderAnchor = () => {
    if (hasRenderAnchor) {
      output.write('\x1B[u');
    }
  };

  const render = () => {
    const innerWidth = getPromptPanelWidth();
    const lines = [];
    const hintLines = wrapPanelLine(styleText(hotkeyHint, ANSI.dim), innerWidth);

    lines.push(styleText(`  ╭${'─'.repeat(innerWidth + 2)}╮`, ANSI.bold, ANSI.brightCyan));
    lines.push(styleText(`  │ ${padVisual(label, innerWidth)} │`, ANSI.bold, ANSI.brightCyan));
    lines.push(styleText(`  ├${'─'.repeat(innerWidth + 2)}┤`, ANSI.bold, ANSI.brightCyan));

    for (const line of hintLines) {
      lines.push(
        `${styleText('  │ ', ANSI.bold, ANSI.brightCyan)}${padVisual(line, innerWidth)}${styleText(' │', ANSI.bold, ANSI.brightCyan)}`,
      );
    }

    lines.push(styleText(`  ├${'─'.repeat(innerWidth + 2)}┤`, ANSI.bold, ANSI.brightCyan));

    for (const [index, option] of options.entries()) {
      const isActive = index === activeIndex;
      const indicator = isActive ? '●' : '○';
      const tone = isActive ? [ANSI.bold, ANSI.brightCyan] : [ANSI.gray];
      const optionLine = `${indicator} ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ''}`;
      const wrappedOptionLines = wrapPanelLine(optionLine, innerWidth);

      for (const wrappedLine of wrappedOptionLines) {
        lines.push(
          `${styleText('  │ ', ANSI.bold, ANSI.brightCyan)}${padVisual(styleText(wrappedLine, ...tone), innerWidth)}${styleText(' │', ANSI.bold, ANSI.brightCyan)}`,
        );
      }
    }

    lines.push(styleText(`  ╰${'─'.repeat(innerWidth + 2)}╯`, ANSI.bold, ANSI.brightCyan));

    saveRenderAnchor();
    restoreRenderAnchor();
    readline.clearScreenDown(output);

    output.write(lines.join('\n'));
    renderedLines = lines.length;
  };

  const clearRenderedBlock = () => {
    if (hasRenderAnchor || renderedLines > 0) {
      restoreRenderAnchor();
      readline.clearScreenDown(output);
      hasRenderAnchor = false;
      renderedLines = 0;
    }
  };

  return await new Promise((resolve) => {
    const cleanup = () => {
      input.off('keypress', onKeypress);

      if (!wasRawMode) {
        input.setRawMode(false);
      }

      if (typeof input.pause === 'function') {
        input.pause();
      }

      if (typeof rl.resume === 'function' && rl.closed !== true) {
        rl.resume();
      }

      output.write('\x1B[?25h');
    };

    const confirmSelection = () => {
      clearRenderedBlock();
      cleanup();
      output.write(`${formatPromptConfirmation(label, options[activeIndex].label, promptOptions)}\n\n`);
      resolve(options[activeIndex].value);
    };

    const onKeypress = (str, key = {}) => {
      if (key.ctrl && key.name === 'c') {
        clearRenderedBlock();
        cleanup();
        output.write('\n');
        process.exit(130);
      }

      if (key.name === 'up' || key.name === 'left') {
        activeIndex = activeIndex === 0 ? options.length - 1 : activeIndex - 1;
        render();
        return;
      }

      if (key.name === 'down' || key.name === 'right') {
        activeIndex = activeIndex === options.length - 1 ? 0 : activeIndex + 1;
        render();
        return;
      }

      if (key.name === 'return' || key.name === 'enter') {
        confirmSelection();
        return;
      }

      const numericIndex = Number.parseInt(str, 10);
      if (Number.isFinite(numericIndex) && numericIndex >= 1 && numericIndex <= options.length) {
        activeIndex = numericIndex - 1;
        confirmSelection();
      }
    };

    if (typeof rl.pause === 'function') {
      rl.pause();
    }

    if (typeof input.resume === 'function') {
      input.resume();
    }

    readline.emitKeypressEvents(input);

    if (!wasRawMode) {
      input.setRawMode(true);
    }

    output.write('\x1B[?25l');
    render();
    input.on('keypress', onKeypress);
  });
}

async function promptChoice(rl, label, options, defaultValue, promptOptions = {}) {
  const hotkeySelection = await promptChoiceWithHotkeys(rl, label, options, defaultValue, promptOptions);
  if (hotkeySelection) {
    return hotkeySelection;
  }

  while (true) {
    log(`${label}:`);
    for (const [index, option] of options.entries()) {
      log(`  ${index + 1}. ${option.label} — ${option.description}`);
    }

    const defaultOption = options.find((option) => option.value === defaultValue);
    const defaultLabel = defaultOption?.label || defaultValue;
    const answer = await rl.question(`${label} [${defaultLabel}]: `);
    const normalized = answer.trim().toLowerCase();

    if (!normalized) {
      return defaultValue;
    }

    const numericIndex = Number.parseInt(normalized, 10);
    if (Number.isFinite(numericIndex) && numericIndex >= 1 && numericIndex <= options.length) {
      return options[numericIndex - 1].value;
    }

    const matchedOption = options.find(
      (option) => option.value === normalized || option.label.toLowerCase() === normalized,
    );
    if (matchedOption) {
      return matchedOption.value;
    }

    logError(`Please choose one of: ${options.map((option) => option.label).join(', ')}.`);
  }
}

async function promptBoolean(rl, label, defaultValue, options = {}) {
  const choice = await promptChoice(
    rl,
    label,
    [
      {
        value: 'true',
        label: 'Yes',
        description: options.trueDescription || 'Enable this setting',
      },
      {
        value: 'false',
        label: 'No',
        description: options.falseDescription || 'Keep the standard setup path',
      },
    ],
    defaultValue ? 'true' : 'false',
    { maskValue: false },
  );

  return choice === 'true';
}

module.exports = {
  supportsRichPromptUi,
  getPromptInputPrefix,
  logPromptError,
  renderPromptPanel,
  promptValue,
  promptChoiceWithHotkeys,
  promptChoice,
  promptBoolean,
};
