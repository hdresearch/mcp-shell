#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { execa } from 'execa';
import commandExists from 'command-exists';
import { updateConfig } from './config.js';

interface CommandResult {
  stdout: string;
  stderr: string;
}

function splitCommand(command: string) {
  const regex = /[^\s"']+|"([^"]*)"|'([^']*)'/g;
  const args: string[] = [];
  let match;

  while ((match = regex.exec(command)) !== null) {
    // Remove outer quotes if present
    args.push(match[1] || match[2] || match[0]);
  }

  return args;
}

// Dangerous commands that should never be allowed
const BLACKLISTED_COMMANDS = new Set([
  // File System Destruction Commands
  'rm', // Remove files/directories - Could delete critical system or user files
  'rmdir', // Remove directories - Could delete important directories
  'del', // Windows delete command - Same risks as rm

  // Disk/Filesystem Commands
  'format', // Formats entire disks/partitions - Could destroy all data on drives
  'mkfs', // Make filesystem - Could reformat drives and destroy data
  'dd', // Direct disk access - Can overwrite raw disks, often called "disk destroyer"

  // Permission/Ownership Commands
  'chmod', // Change file permissions - Could make critical files accessible or inaccessible
  'chown', // Change file ownership - Could transfer ownership of sensitive files

  // Privilege Escalation Commands
  'sudo', // Superuser do - Allows running commands with elevated privileges
  'su', // Switch user - Could be used to gain unauthorized user access

  // Code Execution Commands
  'exec', // Execute commands - Could run arbitrary commands with shell's privileges
  'eval', // Evaluate strings as code - Could execute malicious code injection

  // System Communication Commands
  'write', // Write to other users' terminals - Could be used for harassment/phishing
  'wall', // Write to all users - Could be used for system-wide harassment

  // System Control Commands
  'shutdown', // Shut down the system - Denial of service
  'reboot', // Restart the system - Denial of service
  'init', // System initialization control - Could disrupt system state

  // Additional High-Risk Commands
  'mkfs', // Duplicate of above, filesystem creation - Data destruction risk
]);

// Example validation function
function validateCommand(baseCommand: string): boolean {
  return !BLACKLISTED_COMMANDS.has(baseCommand);
}

class ShellServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'shell-server',
        version: '0.1.0',
      },
      { capabilities: { resources: {}, tools: {} } },
    );

    this.setupErrorHandling();
    this.setupHandlers();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    this.setupToolHandlers();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'run_command',
          description: 'Run a shell command',
          inputSchema: {
            type: 'object',
            properties: {
              command: { type: 'string' },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'run_command') {
        throw new Error(`Unknown tool: ${request.params.name}`);
      }

      const command = request.params.arguments?.command as string;
      try {
        const [shell_command, ...args] = splitCommand(command);
        if (!(await commandExists(shell_command))) {
          throw new Error(`Command not found: ${shell_command}`);
        }

        if (!validateCommand(shell_command)) {
          throw new Error(`Command not allowed: ${shell_command}`);
        }

        const { stdout, stderr } = await execa(shell_command, args, {
          shell: true,
          env: process.env,
        });

        return {
          content: [{ type: 'text', text: stdout || stderr, mimeType: 'text/plain' }],
        };
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: String(error),
              mimeType: 'text/plain',
            },
          ],
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Although this is just an informative message, we must log to stderr,
    // to avoid interfering with MCP communication that happens on stdout
    console.error('MCP server running on stdio');
  }
}

async function main() {
  // setup in claude desktop
  updateConfig();

  // start server
  const server = new ShellServer();
  await server.run();
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
