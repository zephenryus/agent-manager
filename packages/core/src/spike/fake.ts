// Offline spike: a scripted "model" asks for the board, changes one item, then answers.
import { createBoardTools } from "../boardTools.ts";
import { callTool, createFakeProvider, reply } from "../providers/fake.ts";
import { runTurn } from "../turn.ts";
import { printEvent, printSummary, tempBoard } from "./shared.ts";

const boardPath = await tempBoard();
const provider = createFakeProvider([
  callTool("c1", "board_list", {}, "Let me look at the board."),
  callTool("c2", "board_set_status", { id: "PI-2", status: "active" }),
  reply("PI-2 is now active. PI-1 is already active and PI-3 is still proposed."),
]);

console.log("Fake-provider spike\n");
const result = await runTurn({
  provider,
  system: "You are the Research lead.",
  messages: [{ role: "user", text: "Mark PI-2 active and summarize the board." }],
  tools: createBoardTools(boardPath),
  onEvent: printEvent,
});
await printSummary(result, boardPath);
