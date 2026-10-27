import {
  ITEM_STATUSES,
  isItemStatus,
  listItems,
  readBoard,
  setItemStatus,
  writeBoard,
} from "./board.ts";
import type { Tool } from "./types.ts";

/** The two board tools for the P0 spike. Permissions and attribution arrive in P2. */
export function createBoardTools(boardPath: string): Tool[] {
  return [
    {
      name: "board_list",
      description: "List every item on the board with its id, status, title and fields.",
      inputSchema: { type: "object", properties: {} },
      async run() {
        const items = listItems(await readBoard(boardPath));
        return JSON.stringify(items);
      },
    },
    {
      name: "board_set_status",
      description: `Change the status of one board item. Status must be one of: ${ITEM_STATUSES.join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "The item id, e.g. PI-2" },
          status: { type: "string", enum: [...ITEM_STATUSES] },
        },
        required: ["id", "status"],
      },
      async run(input) {
        const { id, status } = input;
        if (typeof id !== "string") throw new Error("id must be a string");
        if (!isItemStatus(status)) {
          throw new Error(`status must be one of: ${ITEM_STATUSES.join(", ")}`);
        }
        const next = setItemStatus(await readBoard(boardPath), id, status);
        await writeBoard(boardPath, next);
        return `Item ${id} is now ${status}.`;
      },
    },
  ];
}
