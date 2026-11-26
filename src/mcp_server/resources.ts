import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, existsSync } from "fs";
import { logger } from "./logger.js";
import { resolveGuidesDir } from "./guidesDir.js";

/**
 * Registers all FigmaMCP resources.
 */
export function registerAllResources(server: McpServer) {
  // Resolve the path to skills/figmamcp/references/
  const skillsDirUrl = resolveGuidesDir(import.meta.url, process.execPath, existsSync);

  const resources = [
    {
      id: "constraints",
      title: "FigmaMCP constraints guide",
      description: "Hard, plugin-enforced rules (scope, name verification, batch validation, URL IDs).",
    },
    {
      id: "error-playbook",
      title: "FigmaMCP error playbook",
      description: "Recovery playbook for every structured error code.",
    },
    {
      id: "workflows",
      title: "FigmaMCP workflows guide",
      description: "Discover-before-acting patterns and recipe skeletons.",
    },
    {
      id: "tool-selection",
      title: "FigmaMCP tool selection guide",
      description: "Guidance on choosing the right tools, using node.info, batch vs single, etc.",
    },
    {
      id: "node-fields",
      title: "FigmaMCP node_info field reference",
      description: "The full set of node_info `properties` (generated from @figma/plugin-typings), with types and how reference fields resolve.",
    },
  ];

  for (const res of resources) {
    const uri = `figmamcp://guide/${res.id}`;
    server.registerResource(
      res.id,
      uri,
      {
        title: res.title,
        description: res.description,
        mimeType: "text/markdown",
      },
      async (url) => {
        try {
          const fileUrl = new URL(`${res.id}.md`, skillsDirUrl);
          if (!existsSync(fileUrl)) {
            throw new Error(`Reference file ${res.id}.md not found`);
          }
          const text = readFileSync(fileUrl, "utf-8");
          return {
            contents: [
              {
                uri: url.toString(),
                text: text,
              },
            ],
          };
        } catch (error) {
          const errorMsg = `Error reading guide: ${error instanceof Error ? error.message : String(error)}`;
          logger.error(errorMsg);
          return {
            contents: [
              {
                uri: url.toString(),
                text: `# Error\n\n${errorMsg}`,
              },
            ],
          };
        }
      }
    );
  }
}
