import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

afterEach(cleanup);

function TwoButtons(): React.JSX.Element {
  return (
    <Modal labelledBy="m-title">
      <h2 id="m-title">Заголовок</h2>
      <button type="button">первая</button>
      <button type="button">последняя</button>
    </Modal>
  );
}

describe('Modal', () => {
  it('начальный фокус — внутри модалки, на первом фокусируемом элементе', () => {
    render(<TwoButtons />);
    expect(document.activeElement?.textContent).toBe('первая');
  });

  it('Tab не выходит за пределы: с последнего элемента — на первый и обратно', () => {
    render(<TwoButtons />);
    const first = screen.getByRole('button', { name: 'первая' });
    const last = screen.getByRole('button', { name: 'последняя' });

    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('после закрытия фокус возвращается на элемент, открывший модалку', () => {
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            открыть
          </button>
          {open && (
            <Modal labelledBy="m-title">
              <h2 id="m-title">Заголовок</h2>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                }}
              >
                закрыть
              </button>
            </Modal>
          )}
        </div>
      );
    }

    render(<Host />);
    const opener = screen.getByRole('button', { name: 'открыть' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement?.textContent).toBe('закрыть');

    fireEvent.click(screen.getByRole('button', { name: 'закрыть' }));
    expect(document.activeElement).toBe(opener);
  });

  it('фокус возвращается и когда React сам сфокусировал кнопку autoFocus', () => {
    // React вызывает autoFocus на коммите, до эффектов: модалка не должна принять свою же
    // кнопку за «элемент, открывший модалку».
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              setOpen(true);
            }}
          >
            открыть
          </button>
          {open && (
            <Modal labelledBy="m-title">
              <h2 id="m-title">Заголовок</h2>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  setOpen(false);
                }}
              >
                отмена
              </button>
            </Modal>
          )}
        </div>
      );
    }

    render(<Host />);
    const opener = screen.getByRole('button', { name: 'открыть' });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement?.textContent).toBe('отмена');

    fireEvent.click(screen.getByRole('button', { name: 'отмена' }));
    expect(document.activeElement).toBe(opener);
  });

  it('опенер исчез — фокус уходит на первый элемент экрана, а не на body', () => {
    // Кнопка плашки отказа исчезает в момент открытия модалки (S6, S17).
    function Host(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return (
        <div>
          <button type="button">первая на экране</button>
          {!open && (
            <button
              type="button"
              onClick={() => {
                setOpen(true);
              }}
            >
              исчезающий опенер
            </button>
          )}
          {open && (
            <Modal labelledBy="m-title">
              <h2 id="m-title">Заголовок</h2>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                }}
              >
                закрыть
              </button>
            </Modal>
          )}
        </div>
      );
    }

    render(<Host />);
    const opener = screen.getByRole('button', { name: 'исчезающий опенер' });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.click(screen.getByRole('button', { name: 'закрыть' }));
    expect(document.activeElement?.textContent).toBe('первая на экране');
  });

  it('пока модалка занята, фокус держится на самом окне', () => {
    function Host({ busy }: { readonly busy: boolean }): React.JSX.Element {
      return (
        <Modal labelledBy="m-title" busy={busy}>
          <h2 id="m-title">Заголовок</h2>
          <button type="button" disabled={busy}>
            действие
          </button>
        </Modal>
      );
    }

    const view = render(<Host busy={false} />);
    // Браузер сбросил бы фокус с недоступной кнопки; в тесте он снимается явно.
    (document.activeElement as HTMLElement | null)?.blur();
    view.rerender(<Host busy />);

    expect(document.activeElement?.getAttribute('role')).toBe('dialog');
  });

  it('B-11: Esc вызывает `onEscape` и дальше модалки не уходит', () => {
    const onEscape = vi.fn();
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Modal labelledBy="m-title" onEscape={onEscape}>
          <h2 id="m-title">Заголовок</h2>
          <input aria-label="поле" />
        </Modal>
      </div>,
    );

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'поле' }), { key: 'Escape' });

    expect(onEscape).toHaveBeenCalledOnce();
    expect(outer).not.toHaveBeenCalled();
  });

  it('B-11: без `onEscape` Esc без действия; Enter и буквы обработчик не вызывают', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <TwoButtons />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'первая' }), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeDefined();
    // Не обработан — всплывает как обычно.
    expect(outer).toHaveBeenCalledOnce();

    cleanup();
    const onEscape = vi.fn();
    render(
      <Modal labelledBy="m-title" onEscape={onEscape}>
        <h2 id="m-title">Заголовок</h2>
        <button type="button">кнопка</button>
      </Modal>,
    );
    const button = screen.getByRole('button', { name: 'кнопка' });
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.keyDown(button, { key: 'q' });
    expect(onEscape).not.toHaveBeenCalled();
  });
});
