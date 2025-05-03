import * as vscode from "vscode";

import { Context, selectionsFromCharacterMode as fromCharacterMode, selectionsToCharacterMode as toCharacterMode } from "./context";
import { NotASelectionError } from "./errors";
import * as Positions from "./positions";
import { Direction, SelectionBehavior, Shift } from "./types";
import { execRange, splitRange } from "../utils/regexp";
import * as TrackedSelection from "../utils/tracked-selection";
import { Selections } from "./selections";

export { fromCharacterMode, toCharacterMode };

/**
 * Reveals selections in the current editor.
 */
export function reveal(selection?: vscode.Selection, context = Context.current) {
  const editor = context.editor,
        active = (selection ?? (editor as vscode.TextEditor).selection).active;

  editor.revealRange(new vscode.Range(active, active));
}

/**
 * Returns a selection spanning the entire buffer.
 */
export function wholeBuffer(document = Context.current.document) {
  return new vscode.Selection(Positions.zero, Positions.last(document));
}

/**
 * Returns the active position (or cursor) of a selection.
 */
export function active(selection: vscode.Selection) {
  return selection.active;
}

/**
 * Returns the anchor position of a selection.
 */
export function anchor(selection: vscode.Selection) {
  return selection.anchor;
}

/**
 * Returns the start position of a selection.
 */
export function start(selection: vscode.Range) {
  return selection.start;
}

/**
 * Returns the end position of a selection.
 */
export function end(selection: vscode.Range) {
  return selection.end;
}

/**
 * Returns the given selection if it faces forward (`active >= anchor`), or
 * the reverse of the given selection otherwise.
 */
export function forward(selection: vscode.Selection) {
  const active = selection.active,
        anchor = selection.anchor;

  return active.isAfterOrEqual(anchor) ? selection : new vscode.Selection(active, anchor);
}

/**
 * Returns the given selection if it faces backward (`active <= anchor`), or
 * the reverse of the given selection otherwise.
 */
export function backward(selection: vscode.Selection) {
  const active = selection.active,
        anchor = selection.anchor;

  return active.isBeforeOrEqual(anchor) ? selection : new vscode.Selection(active, anchor);
}

/**
 * Returns a new empty selection starting and ending at the given position.
 */
export function empty(position: vscode.Position): vscode.Selection;

/**
 * Returns a new empty selection starting and ending at the given line and
 * character.
 */
export function empty(line: number, character: number): vscode.Selection;

export function empty(positionOrLine: vscode.Position | number, character?: number) {
  if (typeof positionOrLine === "number") {
    positionOrLine = new vscode.Position(positionOrLine, character!);
  }

  return new vscode.Selection(positionOrLine, positionOrLine);
}

/**
 * Returns whether the two given ranges overlap.
 */
export function overlap(a: vscode.Range, b: vscode.Range) {
  const aStart = a.start,
        aEnd = a.end,
        bStart = b.start,
        bEnd = b.end;

  return !(aEnd.line < bStart.line
          || (aEnd.line === bEnd.line && aEnd.character < bStart.character))
      && !(bEnd.line < aStart.line
          || (bEnd.line === aEnd.line && bEnd.character < aStart.character));
}

/**
 * Returns the line of the end of the given selection. If the selection ends
 * at the first character of a line and is not empty, this is equal to
 * `end.line - 1`. Otherwise, this is `end.line`.
 */
export function endLine(selection: vscode.Selection | vscode.Range) {
  const startLine = selection.start.line,
        end = selection.end,
        endLine = end.line,
        endCharacter = end.character;

  if (startLine !== endLine && endCharacter === 0) {
    // If the selection ends after a line break, do not consider the next line
    // selected. This is because a selection has to end on the very first
    // caret position of the next line in order to select the last line break.
    // For example, `vscode.TextLine.rangeIncludingLineBreak` does this:
    // https://github.com/microsoft/vscode/blob/c8b27b9db6afc26cf82cf07a9653c89cdd930f6a/src/vs/workbench/api/common/extHostDocumentData.ts#L273
    return endLine - 1;
  }

  return endLine;
}

/**
 * Returns the character of the end of the given selection. If the selection
 * ends at the first character of a line and is not empty, this is equal to
 * the length of the previous line plus one. Otherwise, this is
 * `end.character`.
 *
 * @see endLine
 */
export function endCharacter(
  selection: vscode.Selection | vscode.Range,
  document?: vscode.TextDocument,
) {
  const startLine = selection.start.line,
        end = selection.end,
        endLine = end.line,
        endCharacter = end.character;

  if (startLine !== endLine && endCharacter === 0) {
    return (document ?? Context.current.document).lineAt(endLine - 1).text.length + 1;
  }

  return endCharacter;
}

/**
 * Returns the end position of the given selection. If the selection ends at
 * the first character of a line and is not empty, this is equal to the
 * position at the end of the previous line. Otherwise, this is `end`.
 */
export function endPosition(
  selection: vscode.Selection | vscode.Range,
  document?: vscode.TextDocument,
) {
  const line = endLine(selection);

  if (line !== selection.end.line) {
    return new vscode.Position(
      line,
      (document ?? Context.current.document).lineAt(line).text.length,
    );
  }

  return selection.end;
}

/**
 * Returns the line of the active position of the given selection. If the
 * selection faces forward (the active position is the end of the selection),
 * returns `endLine(selection)`. Otherwise, returns `active.line`.
 */
export function activeLine(selection: vscode.Selection) {
  if (selection.isReversed) {
    return selection.active.line;
  }

  return endLine(selection);
}

/**
 * Returns the character of the active position of the given selection.
 *
 * @see activeLine
 */
export function activeCharacter(selection: vscode.Selection, document?: vscode.TextDocument) {
  if (selection.isReversed) {
    return selection.active.character;
  }

  return endCharacter(selection, document);
}

/**
 * Returns the position of the active position of the given selection.
 */
export function activePosition(selection: vscode.Selection, document?: vscode.TextDocument) {
  if (selection.isReversed) {
    return selection.active;
  }

  return endPosition(selection, document);
}

/**
 * Returns whether the selection spans a single line. This differs from
 * `selection.isSingleLine` because it also handles cases where the selection
 * wraps an entire line (its end position is on the first character of the
 * next line).
 */
export function isSingleLine(selection: vscode.Selection) {
  return selection.start.line === endLine(selection);
}

/**
 * Returns whether the given selection has length `1`.
 */
export function isSingleCharacter(
  selection: vscode.Selection | vscode.Range,
  document = Context.current.document,
) {
  const start = selection.start,
        end = selection.end;

  if (start.line === end.line) {
    return start.character === end.character - 1;
  }

  if (start.line === end.line - 1) {
    return end.character === 0 && document.lineAt(start.line).text.length === start.character;
  }

  return false;
}

/**
 * Returns whether the given selection has length `1` and corresponds to an
 * empty selection extended by one character by `fromCharacterMode`.
 */
export function isNonDirectional(selection: vscode.Selection, context = Context.current) {
  return context.selectionBehavior === SelectionBehavior.Character
      && !selection.isReversed
      && isSingleCharacter(selection, context.document);
}

/**
 * Returns whether the current selection is _strictly reversed_, i.e. it is both
 * **directional** (non-empty, and more than one characters in `character`
 * selection mode) and reversed.
 *
 * {@link vscode.Selection.isReversed} returns `true` even for empty selections,
 * which is not suitable in many cases.
 */
export function isStrictlyReversed(selection: vscode.Selection, context = Context.current) {
  if (selection.isEmpty || !selection.isReversed) {
    // Empty or forward: not reversed.
    return false;
  }

  // In `caret` selection mode, we can stop checking here. In `character`
  // selection mode, 1-character selections are considered "empty", and
  // therefore not reversed.
  return !isNonDirectional(selection, context);
}

/**
 * The position from which a seek operation should start. This is equivalent
 * to `selection.active` except when the selection is non-directional, in
 * which case this is whatever position is **furthest** from the given
 * direction (in order to include the current character in the search).
 *
 * A position other than active (typically, the `anchor`) can be specified to
 * seek from that position.
 */
export function seekFrom(
  selection: vscode.Selection,
  direction: Direction,
  position = selection.active,
  context = Context.current,
) {
  if (context.selectionBehavior === SelectionBehavior.Character) {
    const doc = context.document;

    return direction === Direction.Forward
      ? (position === selection.start ? position : Positions.previous(position, doc) ?? position)
      : (position === selection.end ? position : Positions.next(position, doc) ?? position);
  }

  return position;
}

/**
 * Returns the start position of the active character of the selection.
 *
 * If the current character behavior is `Caret`, this is `selection.active`.
 */
export function activeStart(selection: vscode.Selection, context = Context.current) {
  const active = selection.active;

  if (context.selectionBehavior !== SelectionBehavior.Character) {
    return active;
  }

  const start = selection.start;

  if (isSingleCharacter(selection, context.document)) {
    return start;
  }

  return active === start ? start : Positions.previous(active, context.document)!;
}

/**
 * Returns the end position of the active character of the selection.
 *
 * If the current character behavior is `Caret`, this is `selection.active`.
 */
export function activeEnd(selection: vscode.Selection, context = Context.current) {
  const active = selection.active;

  if (context.selectionBehavior !== SelectionBehavior.Character) {
    return active;
  }

  const end = selection.end;

  if (isSingleCharacter(selection, context.document)) {
    return end;
  }

  return active === end ? end : Positions.next(active, context.document)!;
}

/**
 * Returns `activeStart(selection)` if `direction === Backward`, and
 * `activeEnd(selection)` otherwise.
 */
export function activeTowards(
  selection: vscode.Selection,
  direction: Direction,
  context = Context.current,
) {
  return direction === Direction.Backward
    ? activeStart(selection, context)
    : activeEnd(selection, context);
}

/**
 * Shifts the given selection to the given position using the specified
 * `Shift` behavior:
 * - If `Shift.Jump`, `result.active == result.anchor == position`.
 * - If `Shift.Select`, `result.active == position`, `result.anchor == selection.active`.
 * - If `Shift.Extend`, `result.active == position`, `result.anchor == selection.anchor`.
 *
 * ### Example
 *
 * ```js
 * const s1 = Selections.empty(0, 0),
 *       shifted1 = Selections.shift(s1, Positions.at(0, 4), Select);
 *
 * expect(shifted1, "to have anchor at coords", 0, 0).and("to have cursor at coords", 0, 4);
 * ```
 *
 * With
 *
 * ```
 * line with 23 characters
 * ```
 *
 * ### Example
 *
 * ```js
 * setSelectionBehavior(SelectionBehavior.Character);
 * ```
 */
export function shift(
  selection: vscode.Selection,
  position: vscode.Position,
  shift: Shift,
  context = Context.current,
) {
  let anchor = shift === Shift.Jump
    ? position
    : shift === Shift.Select
      ? selection.active
      : selection.anchor;

  if (context.selectionBehavior === SelectionBehavior.Character && shift !== Shift.Jump) {
    const direction = anchor.isAfter(position) ? Direction.Backward : Direction.Forward;

    anchor = seekFrom(selection, direction, anchor, context);
  }

  return new vscode.Selection(anchor, position);
}

/**
 * Same as `shift`, but also extends the active character towards the given
 * direction in character selection mode. If `direction === Forward`, the
 * active character will be selected such that
 * `activeEnd(selection) === active`. If `direction === Backward`, the
 * active character will be selected such that
 * `activeStart(selection) === active`.
 */
export function shiftTowards(
  selection: vscode.Selection,
  position: vscode.Position,
  shiftTowards: Shift,
  direction: Direction,
  context = Context.current,
) {
  if (context.selectionBehavior === SelectionBehavior.Character
      && direction === Direction.Backward) {
    position = Positions.next(position) ?? position;
  }

  return shift(selection, position, shiftTowards, context);
}

/**
 * Returns whether the given selection spans an entire line.
 *
 * ### Example
 *
 * ```js
 * expect(Selections.isEntireLine(Selections.nth(0)!), "to be true");
 * expect(Selections.isEntireLine(Selections.nth(1)!), "to be false");
 * ```
 *
 * With:
 * ```
 * abc
 * ^^^^ 0
 *
 * def
 * ^^^ 1
 * ```
 *
 * ### Example
 * Use `isEntireLines` for multi-line selections.
 *
 * ```js
 * expect(Selections.isEntireLine(Selections.nth(0)!), "to be false");
 * ```
 *
 * With:
 * ```
 * abc
 * ^^^^ 0
 * def
 * ^^^^ 0
 *
 * ```
 */
export function isEntireLine(selection: vscode.Selection | vscode.Range) {
  const start = selection.start,
        end = selection.end;

  return start.character === 0 && end.character === 0 && start.line === end.line - 1;
}

/**
 * Returns whether the given selection spans one or more entire lines.
 *
 * ### Example
 *
 * ```js
 * expect(Selections.isEntireLines(Selections.nth(0)!), "to be true");
 * expect(Selections.isEntireLines(Selections.nth(1)!), "to be true");
 * expect(Selections.isEntireLines(Selections.nth(2)!), "to be false");
 * ```
 *
 * With:
 * ```
 * abc
 * ^^^^ 0
 * def
 * ^^^^ 0
 * ghi
 * ^^^^ 1
 * jkl
 * ^^^^ 2
 * mno
 * ^^^ 2
 * ```
 */
export function isEntireLines(selection: vscode.Selection | vscode.Range) {
  const start = selection.start,
        end = selection.end;

  return start.character === 0 && end.character === 0 && start.line !== end.line;
}


/**
 * Returns whether the given selection starts with an entire line.
 *
 * ### Example
 *
 * ```js
 * expect(Selections.startsWithEntireLine(Selections.nth(0)!), "to be false");
 * expect(Selections.startsWithEntireLine(Selections.nth(1)!), "to be false");
 * expect(Selections.startsWithEntireLine(Selections.nth(2)!), "to be true");
 * expect(Selections.startsWithEntireLine(Selections.nth(3)!), "to be true");
 * ```
 *
 * With:
 * ```
 * abc
 *    ^ 0
 * def
 *   ^^ 1
 * ghi
 * ^^^^ 1
 * jkl
 * mno
 * ^^^^ 2
 * pqr
 * ^^ 2
 * stu
 * ^^^^ 3
 * vwx
 * ```
 */
export function startsWithEntireLine(selection: vscode.Selection | vscode.Range) {
  const start = selection.start;

  return start.character === 0 && start.line !== selection.end.line;
}

/**
 * Returns whether the given selection ends with an entire line.
 *
 * ### Example
 *
 * ```js
 * expect(Selections.endsWithEntireLine(Selections.nth(0)!), "to be false");
 * expect(Selections.endsWithEntireLine(Selections.nth(1)!), "to be true");
 * expect(Selections.endsWithEntireLine(Selections.nth(2)!), "to be false");
 * expect(Selections.endsWithEntireLine(Selections.nth(3)!), "to be true");
 * ```
 *
 * With:
 * ```
 * abc
 *    ^ 0
 * def
 *   ^^ 1
 * ghi
 * ^^^^ 1
 * jkl
 * mno
 * ^^^^ 2
 * pqr
 * ^^ 2
 * stu
 * ^^^^ 3
 * vwx
 * ```
 */
export function endsWithEntireLine(selection: vscode.Selection | vscode.Range) {
  const end = selection.end;

  return end.character === 0
      && (selection.start.line < end.line - 1
        || (selection.start.line === end.line - 1 && selection.start.character === 0));
}

/**
 * Returns whether the given selection ends with a line break (included).
 *
 * ### Example
 *
 * ```js
 * expect(Selections.endsWithLineBreak(Selections.nth(0)!), "to be true");
 * expect(Selections.endsWithLineBreak(Selections.nth(1)!), "to be true");
 * expect(Selections.endsWithLineBreak(Selections.nth(2)!), "to be false");
 * expect(Selections.endsWithLineBreak(Selections.nth(3)!), "to be true");
 * ```
 *
 * With:
 * ```
 * abc
 *    ^ 0
 * def
 *   ^^ 1
 * ghi
 * ^^^^ 1
 * jkl
 * mno
 * ^^^^ 2
 * pqr
 * ^^ 2
 * stu
 * ^^^^ 3
 * vwx
 * ``` */
export function endsWithLineBreak(selection: vscode.Selection | vscode.Range) {
  const end = selection.end;

  return end.character === 0 && selection.start.line < end.line;
}

export function activeLineIsFullySelected(selection: vscode.Selection) {
  return selection.active === selection.start
    ? startsWithEntireLine(selection)
    : endsWithEntireLine(selection);
}

export function isMovingTowardsAnchor(selection: vscode.Selection, direction: Direction) {
  return direction === Direction.Backward
    ? selection.active === selection.end
    : selection.active === selection.start;
}

/**
 * Returns the text contents of the given selection.
 *
 * ### Example
 *
 * ```js
 * expect(Selections.text(Selections.nth(0)!), "to be", "abc\ndef");
 * expect(Selections.text(Selections.nth(1)!), "to be", "g");
 * expect(Selections.text(Selections.nth(2)!), "to be", "");
 * ```
 *
 * With:
 * ```
 * abc
 * ^^^^ 0
 * def
 * ^^^ 0
 * ghi
 * ^ 1
 *   | 2
 * ```
 */
export function text(
  selection: vscode.Selection | vscode.Range,
  document = Context.current.document,
) {
  return document.getText(selection);
}

/**
 * Returns the length of the given selection.
 *
 * ### Example
 *
 * ```js
 * expect(Selections.length(Selections.nth(0)!), "to be", 7);
 * expect(Selections.length(Selections.nth(1)!), "to be", 1);
 * expect(Selections.length(Selections.nth(2)!), "to be", 0);
 * ```
 *
 * With:
 * ```
 * abc
 * ^^^^ 0
 * def
 * ^^^ 0
 * ghi
 * ^ 1
 *   | 2
 * ```
 */
export function length(
  selection: vscode.Selection | vscode.Range,
  document = Context.current.document,
) {
  const start = selection.start,
        end = selection.end;

  if (start.line === end.line) {
    return end.character - start.character;
  }

  return document.offsetAt(end) - document.offsetAt(start);
}

/**
 * Returns a string representation of the positions of the selection.
 *
 * ### Example
 *
 * ```js
 * expect(Selections.toString(Selections.nth(0)!), "to be", "1:1 → 1:3");
 * expect(Selections.toString(Selections.nth(1)!), "to be", "3:4 → 2:2");
 * ```
 *
 * With:
 * ```
 * abc
 * ^^ 0
 * def
 *  | 1
 * ghi
 *   ^ 1
 * ```
 */
export function toString(selection: vscode.Selection = Selections.current().getPrimarySelection()!) {
  return `${Positions.toString(selection.anchor)} → ${Positions.toString(selection.active)}` as
    const;
}

/**
 * Returns a selection starting at the given position or offset and with the
 * specified length.
 */
export function fromLength(
  start: number | vscode.Position,
  length: number,
  reversed = false,
  document = Context.current.document,
) {
  let startOffset: number,
      startPosition: vscode.Position;

  if (length === 0) {
    if (typeof start === "number") {
      startPosition = document.positionAt(start);
    } else {
      startPosition = start;
    }

    return new vscode.Selection(startPosition, startPosition);
  }

  if (typeof start === "number") {
    startOffset = start;
    startPosition = document.positionAt(start);
  } else {
    startOffset = document.offsetAt(start);
    startPosition = start;
  }

  const endPosition = document.positionAt(startOffset + length);

  return reversed
    ? new vscode.Selection(endPosition, startPosition)
    : new vscode.Selection(startPosition, endPosition);
}

/**
 * Returns a new selection given its start and end positions. If `reversed` is
 * false, the returned solution will be such that `start === anchor` and
 * `end === active`. Otherwise, the returned solution will be such that
 * `start === active` and `end === anchor`.
 *
 * ### Example
 *
 * ```js
 * const p0 = new vscode.Position(0, 0),
 *       p1 = new vscode.Position(0, 1);
 *
 * expect(Selections.fromStartEnd(p0, p1, false), "to satisfy", {
 *   start: p0,
 *   end: p1,
 *   anchor: p0,
 *   active: p1,
 *   isReversed: false,
 * });
 *
 * expect(Selections.fromStartEnd(p0, p1, true), "to satisfy", {
 *   start: p0,
 *   end: p1,
 *   anchor: p1,
 *   active: p0,
 *   isReversed: true,
 * });
 * ```
 */
export function fromStartEnd(
  start: vscode.Position | number,
  end: vscode.Position | number,
  reversed: boolean,
  document?: vscode.TextDocument,
) {
  if (typeof start === "number") {
    if (document === undefined) {
      document = Context.current.document;
    }

    start = document.positionAt(start);
  }

  if (typeof end === "number") {
    if (document === undefined) {
      document = Context.current.document;
    }

    end = document.positionAt(end);
  }

  return reversed ? new vscode.Selection(end, start) : new vscode.Selection(start, end);
}

/**
 * Returns a selection whose anchor is `range.start`, and active position
 * `range.end`.
 */
export function fromRange(range: vscode.Range) {
  return new vscode.Selection(range.start, range.end);
}

/**
 * Returns the selection with the given anchor and active positions.
 */
export function fromAnchorActive(
  anchor: vscode.Position,
  active: vscode.Position,
): vscode.Selection;

/**
 * Returns the selection with the given anchor and active positions.
 */
export function fromAnchorActive(
  anchorLine: number,
  anchorCharacter: number,
  active: vscode.Position,
): vscode.Selection;

/**
 * Returns the selection with the given anchor and active positions.
 */
export function fromAnchorActive(
  anchor: vscode.Position,
  activeLine: number,
  activeCharacter: number,
): vscode.Selection;

/**
 * Returns the selection with the given anchor and active position
 * coordinates.
 */
export function fromAnchorActive(
  anchorLine: number,
  anchorCharacter: number,
  activeLine: number,
  activeCharacter: number,
): vscode.Selection;

export function fromAnchorActive(
  anchorOrAnchorLine: number | vscode.Position,
  activeOrAnchorCharacterOrActiveLine: number | vscode.Position,
  activeOrActiveLineOrActiveCharacter?: number | vscode.Position,
  activeCharacter?: number,
) {
  if (activeCharacter !== undefined) {
    // Four arguments: this is the last overload.
    const anchorLine = anchorOrAnchorLine as number,
          anchorCharacter = activeOrAnchorCharacterOrActiveLine as number,
          activeLine = activeOrActiveLineOrActiveCharacter as number;

    return new vscode.Selection(anchorLine, anchorCharacter, activeLine, activeCharacter);
  }

  if (activeOrActiveLineOrActiveCharacter === undefined) {
    // Two arguments: this is the first overload.
    const anchor = anchorOrAnchorLine as vscode.Position,
          active = activeOrAnchorCharacterOrActiveLine as vscode.Position;

    return new vscode.Selection(anchor, active);
  }

  if (typeof activeOrActiveLineOrActiveCharacter === "number") {
    // Third argument is a number: this is the third overload.
    const anchor = anchorOrAnchorLine as vscode.Position,
          activeLine = activeOrAnchorCharacterOrActiveLine as number,
          activeCharacter = activeOrActiveLineOrActiveCharacter as number;

    return new vscode.Selection(anchor, new vscode.Position(activeLine, activeCharacter));
  }

  // Third argument is a position: this is the second overload.
  const anchorLine = anchorOrAnchorLine as number,
        anchorCharacter = activeOrAnchorCharacterOrActiveLine as number,
        active = activeOrActiveLineOrActiveCharacter as vscode.Position;

  return new vscode.Selection(new vscode.Position(anchorLine, anchorCharacter), active);
}

/**
 * Shorthand for `fromAnchorActive`.
 */
export const from = fromAnchorActive;
