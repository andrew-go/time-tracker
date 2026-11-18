// Small DOM helpers. User data only ever goes through textContent/attributes
// (never innerHTML), so names and descriptions can't inject markup.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'style') for (const [p, v] of Object.entries(value)) el.style.setProperty(p, v);
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return el;
}

export function fillDatalist(list, names) {
  list.replaceChildren(...names.map((value) => h('option', { value })));
}

/** Show a short message in the polite live region. */
let statusTimer;
export function announce(message) {
  const el = document.getElementById('status');
  el.textContent = message;
  el.classList.add('visible');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => el.classList.remove('visible'), 3500);
}

/** Open a modal dialog and resolve with the button value that closed it ('' if dismissed). */
export function runDialog(dialog) {
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        const value = dialog.returnValue;
        dialog.returnValue = ''; // browsers differ on clearing it after Esc
        resolve(value);
      },
      { once: true },
    );
    dialog.showModal();
  });
}

export async function confirmDialog({ title, message, confirmLabel = 'Delete' }) {
  const dialog = document.getElementById('confirm-dialog');
  dialog.querySelector('#confirm-title').textContent = title;
  dialog.querySelector('#confirm-message').textContent = message;
  dialog.querySelector('#confirm-ok').textContent = confirmLabel;
  return (await runDialog(dialog)) === 'ok';
}

/**
 * Ask for a name (and optionally a color).
 * `validate(name)` returns an error message or ''.
 */
export async function nameDialog({ title, name = '', color, validate = () => '' }) {
  const dialog = document.getElementById('name-dialog');
  const input = dialog.querySelector('#nf-name');
  const colorField = dialog.querySelector('#nf-color-field');
  const colorInput = dialog.querySelector('#nf-color');

  dialog.querySelector('#name-dialog-title').textContent = title;
  input.value = name;
  input.setCustomValidity('');
  colorField.hidden = color == null;
  if (color != null) colorInput.value = color;

  const check = () => input.setCustomValidity(validate(input.value.trim()));
  input.addEventListener('input', check);
  input.setAttribute('autofocus', '');

  const result = await runDialog(dialog);
  input.removeEventListener('input', check);
  if (result !== 'save') return null;
  return { name: input.value.trim(), color: colorInput.value };
}

/** Light-dismiss fallback for browsers without <dialog closedby> (Safari). */
export function polyfillClosedBy() {
  if ('closedBy' in HTMLDialogElement.prototype) return;
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    // Test the pointer position, not event.target: padding/gaps also target the dialog.
    const outside = (e) => {
      const r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => { pressedOutside = outside(e); });
    dialog.addEventListener('pointerup', (e) => { if (pressedOutside && outside(e)) dialog.close(); });
  }
}
