import { type IAgentRuntime, Service, logger } from "@elizaos/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  CallToolResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_MCP_TIMEOUT_SECONDS,
  MCP_SERVICE_NAME,
  type McpConnection,
  type McpProvider,
  type McpResourceResponse,
  type McpServer,
  type McpServerConfig,
  type McpSettings,
  type SseMcpServerConfig,
  type StdioMcpServerConfig,
} from "./types";
import { buildMcpProviderData } from "./utils/mcp";

export class McpService extends Service {
  static serviceType: string = MCP_SERVICE_NAME;
  capabilityDescription = "Enables the agent to interact with MCP (Model Context Protocol) servers";

  private connections: McpConnection[] = [];
  private mcpProvider: McpProvider = {
    values: { mcp: {} },
    data: { mcp: {} },
    text: "",
  };

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.initializeMcpServers();
  }

  static async start(runtime: IAgentRuntime): Promise<McpService> {
    const service = new McpService(runtime);
    return service;
  }

  async stop(): Promise<void> {
    for (const connection of this.connections) {
      try {
        await this.deleteConnection(connection.server.name);
      } catch (error) {
        logger.error(
          `Failed to close connection for ${connection.server.name}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    this.connections = [];
  }

  private async initializeMcpServers(): Promise<void> {
    try {
      const mcpSettings = this.getMcpSettings();

      if (!mcpSettings || !mcpSettings.servers) {
        logger.info("No MCP servers configured.");
        return;
      }

      await this.updateServerConnections(mcpSettings.servers);

      const servers = this.getServers();

      this.mcpProvider = buildMcpProviderData(servers);
    } catch (error) {
      logger.error(
        "Failed to initialize MCP servers:",
        error instanceof Error ? error.message : String(error)
      );
    }
  }

  private getMcpSettings(): McpSettings | undefined {
    return this.runtime.getSetting("mcp") as McpSettings;
  }

  private async updateServerConnections(
    serverConfigs: Record<string, McpServerConfig>
  ): Promise<void> {
    const currentNames = new Set(this.connections.map((conn) => conn.server.name));
    const newNames = new Set(Object.keys(serverConfigs));

    for (const name of currentNames) {
      if (!newNames.has(name)) {
        await this.deleteConnection(name);
        logger.info(`Deleted MCP server: ${name}`);
      }
    }

    for (const [name, config] of Object.entries(serverConfigs)) {
      const currentConnection = this.connections.find((conn) => conn.server.name === name);

      if (!currentConnection) {
        try {
          await this.connectToServer(name, config);
        } catch (error) {
          logger.error(
            `Failed to connect to new MCP server ${name}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      } else if (JSON.stringify(config) !== currentConnection.server.config) {
        try {
          await this.deleteConnection(name);
          await this.connectToServer(name, config);
          logger.info(`Reconnected MCP server with updated config: ${name}`);
        } catch (error) {
          logger.error(
            `Failed to reconnect MCP server ${name}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }
  }

  private async buildStdioClientTransport(name: string, config: StdioMcpServerConfig) {
    if (!config.command) {
      throw new Error(`Missing command for stdio MCP server ${name}`);
    }

    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: {
        ...config.env,
        ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      },
      stderr: "pipe",
      cwd: config.cwd,
    });
  }

  private async buildSseClientTransport(name: string, config: SseMcpServerConfig) {
    if (!config.url) {
      throw new Error(`Missing URL for SSE MCP server ${name}`);
    }

    return new SSEClientTransport(new URL(config.url));
  }

  private async connectToServer(name: string, config: McpServerConfig): Promise<void> {
    this.connections = this.connections.filter((conn) => conn.server.name !== name);

    try {
      const client = new Client(
        {
          name: "ElizaOS",
          version: "1.0.0",
        },
        {
          capabilities: {},
        }
      );

      const transport: StdioClientTransport | SSEClientTransport =
        config.type === "stdio"
          ? await this.buildStdioClientTransport(name, config)
          : await this.buildSseClientTransport(name, config);

      const connection: McpConnection = {
        server: {
          name,
          config: JSON.stringify(config),
          status: "connecting",
        },
        client,
        transport,
      };

      this.connections.push(connection);

      transport.onerror = async (error) => {
        logger.error(`Transport error for "${name}":`, error);
        connection.server.status = "disconnected";
        this.appendErrorMessage(connection, error.message);
      };

      transport.onclose = async () => {
        connection.server.status = "disconnected";
      };

      await client.connect(transport);

      connection.server = {
        status: "connected",
        name,
        config: JSON.stringify(config),
        error: "",
        tools: await this.fetchToolsList(name),
        resources: await this.fetchResourcesList(name),
        resourceTemplates: await this.fetchResourceTemplatesList(name),
      };

      logger.info(`Successfully connected to MCP server: ${name}`);
    } catch (error) {
      const connection = await this.getServerConnection(name);
      if (connection) {
        connection.server.status = "disconnected";
        this.appendErrorMessage(connection, error instanceof Error ? error.message : String(error));
      }
      throw error;
    }
  }

  private appendErrorMessage(connection: McpConnection, error: string) {
    const newError = connection.server.error ? `${connection.server.error}\n${error}` : error;
    connection.server.error = newError;
  }

  async deleteConnection(name: string): Promise<void> {
    const connection = this.getServerConnection(name);
    if (connection) {
      try {
        await connection.transport.close();
        await connection.client.close();
      } catch (error) {
        logger.error(
          `Failed to close transport for ${name}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
      this.connections = this.connections.filter((conn) => conn.server.name !== name);
    }
  }

  private getServerConnection(serverName: string): McpConnection | undefined {
    return this.connections.find((conn) => conn.server.name === serverName);
  }

  private async fetchToolsList(serverName: string): Promise<Tool[]> {
    try {
      const connection = this.getServerConnection(serverName);
      if (!connection) {
        return [];
      }

      const response = await connection.client.listTools();

      const tools = (response?.tools || []).map((tool) => ({
        ...tool,
      }));

      logger.info(`Fetched ${tools.length} tools for ${serverName}`);
      for (const tool of tools) {
        logger.info(`[${serverName}] ${tool.name}: ${tool.description}`);
      }

      return tools;
    } catch (error) {
      logger.error(
        `Failed to fetch tools for ${serverName}:`,
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  }

  private async fetchResourcesList(serverName: string): Promise<Resource[]> {
    try {
      const connection = this.getServerConnection(serverName);
      if (!connection) {
        return [];
      }

      const response = await connection.client.listResources();
      return response?.resources || [];
    } catch (error) {
      logger.warn(
        `No resources found for ${serverName}:`,
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  }

  private async fetchResourceTemplatesList(serverName: string): Promise<ResourceTemplate[]> {
    try {
      const connection = this.getServerConnection(serverName);
      if (!connection) {
        return [];
      }

      const response = await connection.client.listResourceTemplates();
      return response?.resourceTemplates || [];
    } catch (error) {
      logger.warn(
        `No resource templates found for ${serverName}:`,
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  }

  public getServers(): McpServer[] {
    return this.connections.filter((conn) => !conn.server.disabled).map((conn) => conn.server);
  }

  public getProviderData(): McpProvider {
    return this.mcpProvider;
  }

  public async callTool(
    serverName: string,
    toolName: string,
    toolArguments?: Record<string, unknown>
  ): Promise<CallToolResult> {
    const connection = this.connections.find((conn) => conn.server.name === serverName);
    if (!connection) {
      throw new Error(`No connection found for server: ${serverName}`);
    }

    if (connection.server.disabled) {
      throw new Error(`Server "${serverName}" is disabled`);
    }

    let timeout = DEFAULT_MCP_TIMEOUT_SECONDS;
    try {
      const config = JSON.parse(connection.server.config);
      timeout = config.timeoutInMillis || DEFAULT_MCP_TIMEOUT_SECONDS;
    } catch (error) {
      logger.error(
        `Failed to parse timeout configuration for server ${serverName}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    const result = await connection.client.callTool(
      { name: toolName, arguments: toolArguments },
      undefined,
      { timeout }
    );

    if (!result.content) {
      throw new Error("Invalid tool result: missing content array");
    }

    return result as CallToolResult;
  }

  public async readResource(serverName: string, uri: string): Promise<McpResourceResponse> {
    const connection = this.connections.find((conn) => conn.server.name === serverName);
    if (!connection) {
      throw new Error(`No connection found for server: ${serverName}`);
    }

    if (connection.server.disabled) {
      throw new Error(`Server "${serverName}" is disabled`);
    }

    return await connection.client.readResource({ uri });
  }

  public async restartConnection(serverName: string): Promise<void> {
    const connection = this.connections.find((conn) => conn.server.name === serverName);
    const config = connection?.server.config;
    if (config) {
      logger.info(`Restarting ${serverName} MCP server...`);
      connection.server.status = "connecting";
      connection.server.error = "";

      try {
        await this.deleteConnection(serverName);

        await this.connectToServer(serverName, JSON.parse(config));
        logger.info(`${serverName} MCP server connected`);
      } catch (error) {
        logger.error(
          `Failed to restart connection for ${serverName}:`,
          error instanceof Error ? error.message : String(error)
        );
        throw new Error(`Failed to connect to ${serverName} MCP server`);
      }
    }
  }
}
