import { Fragment, type ReactNode } from 'react';

/**
 * Текст локали с переводами строк — строками с `<br/>` между ними (`preview.lost`,
 * `flip.illustration`). Один помощник на все экраны: правка поведения не разъезжается.
 */
export function multiline(text: string): ReactNode {
  return text.split('\n').map((line, index) => (
    <Fragment key={index}>
      {index > 0 && <br />}
      {line}
    </Fragment>
  ));
}
