import { describe, it, expect } from 'vitest';
import { applyCorrections } from '../utils/descriptionCorrections';

// Spell-check corrections a developer approved, applied to a description as Jira stores it (wiki
// markup): only the listed words change, and code, monospace and link targets are never touched.

describe('applying approved corrections to a description', () => {
  it('changes only the corrected word and keeps every other character, markup included', () => {
    const wiki = 'h2. Steps\n{panel:title=Note}{color:red}Urgent{color}{panel}\n||Step||Expected||\n|Open the page|Form is shwon|\nAsk [~jdoe].';
    expect(applyCorrections(wiki, [{ before: 'shwon', after: 'shown' }])).toEqual({
      text: 'h2. Steps\n{panel:title=Note}{color:red}Urgent{color}{panel}\n||Step||Expected||\n|Open the page|Form is shown|\nAsk [~jdoe].',
    });
  });

  it('applies several corrections at once', () => {
    expect(applyCorrections('Teh form is shwon.', [{ before: 'Teh', after: 'The' }, { before: 'shwon', after: 'shown' }]))
      .toEqual({ text: 'The form is shown.' });
  });

  it('corrects a word inside bold text when the correction names the word alone', () => {
    expect(applyCorrections('This is *recieved* now.', [{ before: 'recieved', after: 'received' }])).toEqual({ text: 'This is *received* now.' });
  });

  it('refuses a correction whose text appears more than once, and changes nothing', () => {
    expect(applyCorrections('shwon here and shwon there', [{ before: 'shwon', after: 'shown' }])).toEqual({
      refused: [{ number: 1, before: 'shwon', reason: 'not unique' }],
    });
  });

  it('refuses a correction whose text is no longer in the description, for example after an edit', () => {
    expect(applyCorrections('The form is shown.', [{ before: 'shwon', after: 'shown' }])).toEqual({
      refused: [{ number: 1, before: 'shwon', reason: 'not found' }],
    });
  });

  it.each([
    ['a code block', 'Before.\n{code:java}\nString recieved = input();\n{code}\nAfter.'],
    ['a noformat block', '{noformat}\nrecieved\n{noformat}'],
    ['monospace', 'Call {{recieved()}} first.'],
    ['a link target', 'See [the spec|http://wiki/recieved].'],
    ['a link with no text', 'See [http://wiki/recieved].'],
    ['a bare web address', 'See http://wiki/recieved for details.'],
    ['an image embed', 'Look: !recieved_screen.png|thumbnail! here.'],
  ])('refuses a correction inside %s', (_where, wiki) => {
    expect(applyCorrections(wiki, [{ before: 'recieved', after: 'received' }])).toEqual({
      refused: [{ number: 1, before: 'recieved', reason: 'protected' }],
    });
  });

  it("corrects a link's text but never its target", () => {
    expect(applyCorrections('See [the recieved spec|http://wiki/spec].', [{ before: 'recieved', after: 'received' }]))
      .toEqual({ text: 'See [the received spec|http://wiki/spec].' });
  });

  it('refuses the whole write when one of several corrections is refused, and names only that one', () => {
    expect(applyCorrections('Teh form. {{shwon}}', [{ before: 'Teh', after: 'The' }, { before: 'shwon', after: 'shown' }])).toEqual({
      refused: [{ number: 2, before: 'shwon', reason: 'protected' }],
    });
  });

  it('refuses two corrections whose text overlaps', () => {
    expect(applyCorrections('Teh form is shwon.', [{ before: 'is shwon', after: 'is shown' }, { before: 'shwon.', after: 'shown.' }])).toEqual({
      refused: [{ number: 2, before: 'shwon.', reason: 'overlaps' }],
    });
  });

  it('keeps a code block protected when a noformat block before it shows a literal code tag', () => {
    const wiki = '{noformat}write {code} like this{noformat}\nText.\n{code}\nString recieved;\n{code}';
    expect(applyCorrections(wiki, [{ before: 'recieved', after: 'received' }])).toEqual({
      refused: [{ number: 1, before: 'recieved', reason: 'protected' }],
    });
  });

  it.each([
    ['an image', 'recieved !http://evil/x.gif!'],
    ['a link', '[recieved|http://evil]'],
    ['a macro', '{color:red}received{color}'],
    ['monospace', '{{received}}'],
  ])('refuses a correction that would add %s to the description', (_what, after) => {
    expect(applyCorrections('It was recieved.', [{ before: 'recieved', after }])).toEqual({
      refused: [{ number: 1, before: 'recieved', reason: 'adds markup' }],
    });
  });

  it('accepts a correction that keeps markup characters the original text already had', () => {
    expect(applyCorrections('See *teh* note.', [{ before: '*teh*', after: '*the*' }])).toEqual({ text: 'See *the* note.' });
  });

  it('refuses a correction with no text to replace', () => {
    expect(applyCorrections('Text.', [{ before: '', after: 'x' }])).toEqual({
      refused: [{ number: 1, before: '', reason: 'empty' }],
    });
  });
});
