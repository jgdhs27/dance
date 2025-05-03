import * as vscode from "vscode";
import {
  Context,
  selectionsFromCharacterMode as fromCharacterMode,
  selectionsToCharacterMode as toCharacterMode,
} from "./context";
import * as Positions from "./positions";
import { Direction } from "./types";
import { execRange, splitRange } from "../utils/regexp";
import { empty, endLine, fromStartEnd } from "./selection";

export { fromCharacterMode, toCharacterMode };

export class Selections {
  private primarySelection!: vscode.Selection;
  private selections: Array<vscode.Selection>;

  public constructor(
    selections: vscode.Selection[],
    primarySelection: vscode.Selection | null = null
  ) {
    this.selections = selections;
    this.primarySelection = primarySelection ?? selections[0];
    this.sort();
  }

  public getPrimarySelection() {
    return this.primarySelection;
  }

  public getSelections() {
    return this.selections;
  }

  public sort(): void {
    this.selections = this.selections.sort((a, b) =>
      a.start.compareTo(b.start)
    );
  }

  public static current(): Selections {
    return new this(Context.current.selections.slice());
  }

  /**
   * Sets the current selections.
   *
   * ### Example
   *
   * ```js
   * const start = new vscode.Position(0, 6),
   *       end = new vscode.Position(0, 11);
   *
   * Selections.set([new vscode.Selection(start, end)]);
   * ```
   *
   * Before:
   * ```
   * hello world
   * ^ 0
   * ```
   *
   * After:
   * ```
   * hello world
   *       ^^^^^ 0
   * ```
   *
   * ### Example
   * ```js
   * expect(() => Selections.set([]), "to throw an", EmptySelectionsError);
   * expect(() => Selections.set([1 as any]), "to throw a", NotASelectionError);
   * ```
   */
  public setCurrent(context = Context.current) {
    context.selections = this.selections;

    const editor = context.editor,
      active = (
        this.primarySelection ?? (editor as vscode.TextEditor).selection
      ).active;
    editor.revealRange(new vscode.Range(active, active));

    vscode.commands.executeCommand("editor.action.wordHighlight.trigger");
  }

  public rotate(by: Direction | number) {
    const primarySelectionIndex = this.selections.indexOf(
      this.primarySelection
    );
    this.primarySelection =
      this.selections[(primarySelectionIndex + by) % this.selections.length];
  }

  /**
   * Returns an array containing all the unique lines included in the given or
   * active selections. Though the resulting array is not sorted, it is likely
   * that consecutive lines will be consecutive in the array as well.
   *
   * ### Example
   *
   * ```js
   * expect(Selections.lines(), "to only contain", 0, 1, 3, 4, 5, 6);
   * ```
   *
   * With:
   * ```
   * ab
   * ^^ 0
   * cd
   * ^ 1
   * ef
   * gh
   * ^ 2
   *  ^ 3
   * ij
   * ^ 3
   * kl
   * | 4
   * mn
   *  ^^ 5
   * op
   * ```
   */
  public lines() {
    const lines: number[] = [];

    for (const selection of this.selections) {
      const startLine = selection.start.line,
        endLine_ = endLine(selection);

      // The first and last lines of the selection may contain other selections,
      // so we check for duplicates with them. However, the intermediate
      // lines are known to belong to one selection only, so there's no need
      // for that with them.
      if (lines.indexOf(startLine) === -1) {
        lines.push(startLine);
      }

      for (let i = startLine + 1; i < endLine_; i++) {
        lines.push(i);
      }

      if (endLine_ !== startLine && lines.indexOf(endLine_) === -1) {
        lines.push(endLine_);
      }
    }

    return lines;
  }

  /**
   * Returns the selections obtained by splitting the contents of all the given
   * selections using the given RegExp.
   */
  public split(re: RegExp) {
    const document = Context.current.document;

    // TODO what does this do to the primary selection?
    this.selections = this.selections
      .map((selection) => {
        const offset = document.offsetAt(selection.start);

        return splitRange(document.getText(selection), re).map(([start, end]) =>
          fromStartEnd(offset + start, offset + end, selection.isReversed)
        );
      }, this.selections)
      .flat();
  }

  /**
   * Returns the selections obtained by finding all the matches within the given
   * selections using the given RegExp.
   *
   * ### Example
   *
   * ```ts
   * expect(Selections.selectWithin(/\d/).map<string>(text), "to equal", [
   *   "1",
   *   "2",
   *   "6",
   *   "7",
   *   "8",
   * ]);
   * ```
   *
   * With:
   * ```
   * a1b2c3d4
   * ^^^^^ 0
   * e5f6g7h8
   *   ^^^^^^ 1
   * ```
   */
  public selectWithin(re: RegExp) {
    const document = Context.current.document;

    this.selections = this.selections
      .map((selection) => {
        const offset = document.offsetAt(selection.start);

        return execRange(document.getText(selection), re).map(([start, end]) =>
          fromStartEnd(offset + start, offset + end, selection.isReversed)
        );
      }, this.selections)
      .flat();
  }

  private merge(options: { alsoMergeConsecutiveSelections: boolean }) {
    const len = this.selections.length,
      ignoreSelections = new Uint8Array(this.selections.length);
    let newSelections: vscode.Selection[] | undefined;

    for (let i = 0; i < len; i++) {
      if (ignoreSelections[i] === 1) {
        continue;
      }

      const a = this.selections[i];
      let aStart = a.start,
        aEnd = a.end,
        aIsEmpty = aStart.isEqual(aEnd),
        changed = false;

      for (let j = i + 1; j < len; j++) {
        if (ignoreSelections[j] === 1) {
          continue;
        }

        const b = this.selections[j],
          bStart = b.start,
          bEnd = b.end;

        if (aIsEmpty) {
          if (bStart.isEqual(bEnd)) {
            if (bStart.isEqual(aStart)) {
              // A and B are two equal empty selections, and we can keep A.
              ignoreSelections[j] = 1;
              changed = true;
            } else {
              // A and B are two different empty selections, we don't change
              // anything.
            }

            continue;
          }

          if (bStart.isBeforeOrEqual(aStart) && bEnd.isAfterOrEqual(bStart)) {
            // The empty selection A is included in B.
            aStart = bStart;
            aEnd = bEnd;
            aIsEmpty = false;
            changed = true;
            ignoreSelections[j] = 1;

            continue;
          }

          // The empty selection A is strictly before or after B.
          continue;
        }

        if (
          aStart.isAfterOrEqual(bStart) &&
          (aStart.isBefore(bEnd) ||
            (options.alsoMergeConsecutiveSelections && aStart.isEqual(bEnd)))
        ) {
          // Selection A starts within selection B...
          if (aEnd.isBeforeOrEqual(bEnd)) {
            // ... and ends within selection B (it is included in selection B).
            aStart = b.start;
            aEnd = b.end;
          } else {
            // ... and ends after selection B.
            if (aStart.isEqual(bStart)) {
              // B is included in A: avoid creating a new selection needlessly.
              ignoreSelections[j] = 1;
              newSelections ??= this.selections.slice(0, i);
              continue;
            }
            aStart = bStart;
          }
        } else if (
          (aEnd.isAfter(bStart) ||
            (options.alsoMergeConsecutiveSelections && aEnd.isEqual(bStart))) &&
          aEnd.isBeforeOrEqual(bEnd)
        ) {
          // Selection A ends within selection B. Furthermore, we know that
          // selection A does not start within selection B, so it starts before
          // selection B.
          aEnd = bEnd;
        } else {
          // Selection A neither starts nor ends in selection B, so there is no
          // overlap.
          continue;
        }

        // B is NOT included in A; we must look at selections we previously saw
        // again since they may now overlap with the new selection we will create.
        changed = true;
        ignoreSelections[j] = 1;

        j = i; // `j++` above will set `j` to `i + 1`.
      }

      if (changed) {
        // Selections have changed: make sure the `newSelections` are initialized
        // and push the new selection.
        if (newSelections === undefined) {
          newSelections = this.selections.slice(0, i);
        }

        newSelections.push(fromStartEnd(aStart, aEnd, a.isReversed));
      } else if (newSelections !== undefined) {
        // Selection did not change, but a previous selection did; push existing
        // selection to new array.
        newSelections.push(a);
      } else {
        // Selections have not changed. Just keep going.
      }
    }

    this.selections =
      newSelections !== undefined ? newSelections : this.selections;
  }

  /**
   * Given an array of selections, returns an array of selections where all
   * overlapping selections have been merged.
   *
   * ### Example
   *
   * Equal selections.
   *
   * ```ts
   * expect(Selections.mergeOverlapping(), "to equal", [Selections.nth(0)]);
   * ```
   *
   * With:
   * ```
   * abcd
   *  ^^ 0
   *  ^^ 1
   * ```
   *
   * ### Example
   *
   * Equal empty selections.
   *
   * ```ts
   * expect(Selections.mergeOverlapping(), "to equal", [Selections.nth(0)]);
   * ```
   *
   * With:
   * ```
   * abcd
   *  | 0
   *  | 1
   * ```
   *
   * ### Example
   *
   * Overlapping selections.
   *
   * ```ts
   * expect(Selections.mergeOverlapping(), "to satisfy", [
   *   expect.it("to start at coords", 0, 0).and("to end at coords", 0, 4),
   * ]);
   * ```
   *
   * With:
   * ```
   * abcd
   * ^^^ 0
   *  ^^^ 1
   * ```
   */
  public mergeOverlapping() {
    return this.merge({ alsoMergeConsecutiveSelections: false });
  }

  /**
   * Same as `mergeOverlapping`, but also merging consecutive selections.
   *
   * ### Example
   *
   * Consecutive selections.
   *
   * ```ts
   * expect(Selections.mergeOverlapping(), "to equal", Selections.current());
   *
   * expect(Selections.mergeConsecutive(), "to satisfy", [
   *   expect.it("to start at coords", 0, 0).and("to end at coords", 0, 4),
   * ]);
   * ```
   *
   * With:
   * ```
   * abcd
   * ^^ 0
   *   ^^ 1
   * ```
   *
   * ### Example
   *
   * Consecutive selections (reversed).
   *
   * ```ts
   * expect(Selections.mergeOverlapping(), "to equal", Selections.current());
   *
   * expect(Selections.mergeConsecutive(), "to satisfy", [
   *   expect.it("to start at coords", 0, 0).and("to end at coords", 0, 4),
   * ]);
   * ```
   *
   * With:
   * ```
   * abcd
   * ^^ 1
   *   ^^ 0
   * ```
   */
  public mergeConsecutive() {
    return this.merge({ alsoMergeConsecutiveSelections: true });
  }

  /**
   * Returns the selection at the given index.
   */
  public nth(index: number) {
    return this.selections[index] as vscode.Selection | undefined;
  }
}

/**
 * Shifts empty selections by one character to the left.
 */
export function shiftEmptyLeft(
  selections: vscode.Selection[],
  document?: vscode.TextDocument
) {
  for (let i = 0; i < selections.length; i++) {
    const selection = selections[i];

    if (selection.isEmpty) {
      if (document === undefined) {
        document = Context.current.document;
      }

      const newPosition = Positions.previous(selection.active, document);

      if (newPosition !== undefined) {
        selections[i] = empty(newPosition);
      }
    }
  }
}
