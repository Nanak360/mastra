import {
  AssistantContent,
  CoreAssistantMessage,
  CoreMessage,
  CoreToolMessage,
  CoreUserMessage,
  TextPart,
  ToolCallPart,
  UserContent,
} from 'ai';
import { randomUUID } from 'crypto';
import { JSONSchema7 } from 'json-schema';
import { z, ZodSchema } from 'zod';

import 'dotenv/config';

import { MastraPrimitives } from '../action';
import { MastraBase } from '../base';
import { Metric } from '../eval';
import { AvailableHooks, executeHook } from '../hooks';
import { LLM } from '../llm';
import { GenerateReturn, ModelConfig, StreamReturn } from '../llm/types';
import { LogLevel, RegisteredLogger } from '../logger';
import { MemoryConfig, StorageThreadType } from '../memory';
import { InstrumentClass } from '../telemetry';
import { CoreTool, ToolAction } from '../tools/types';

import type { AgentConfig, AgentGenerateOptions, AgentStreamOptions, ToolsetsInput } from './types';

@InstrumentClass({
  prefix: 'agent',
  excludeMethods: ['__setTools', '__setLogger', '__setTelemetry', 'log'],
})
export class Agent<
  TTools extends Record<string, ToolAction<any, any, any, any>> = Record<string, ToolAction<any, any, any, any>>,
  TMetrics extends Record<string, Metric> = Record<string, Metric>,
> extends MastraBase {
  public name: string;
  readonly llm: LLM;
  readonly instructions: string;
  readonly model: ModelConfig;
  #mastra?: MastraPrimitives;
  tools: TTools;
  metrics: TMetrics;

  constructor(config: AgentConfig<TTools, TMetrics>) {
    super({ component: RegisteredLogger.AGENT });

    this.name = config.name;
    this.instructions = config.instructions;

    this.llm = new LLM({ model: config.model });

    this.model = config.model;

    this.tools = {} as TTools;

    this.metrics = {} as TMetrics;

    if (config.tools) {
      this.tools = config.tools;
    }

    if (config.mastra) {
      this.#mastra = config.mastra;
    }

    if (config.metrics) {
      this.metrics = config.metrics;
    }
  }

  __registerPrimitives(p: MastraPrimitives) {
    if (p.telemetry) {
      this.__setTelemetry(p.telemetry);
    }

    if (p.logger) {
      this.__setLogger(p.logger);
    }

    this.llm.__registerPrimitives(p);

    this.#mastra = p;

    this.logger.debug(`[Agents:${this.name}] initialized.`, { model: this.model, name: this.name });
  }

  /**
   * Set the concrete tools for the agent
   * @param tools
   */
  __setTools(tools: TTools) {
    this.tools = tools;
    this.logger.debug(`[Agents:${this.name}] Tools set for agent ${this.name}`, { model: this.model, name: this.name });
  }

  async generateTitleFromUserMessage({ message }: { message: CoreUserMessage }) {
    const { object } = await this.llm.__textObject<{ title: string }>({
      messages: [
        {
          role: 'system',
          content: `\n
      - you will generate a short title based on the first message a user begins a conversation with
      - ensure it is not more than 80 characters long
      - the title should be a summary of the user's message
      - do not use quotes or colons`,
        },
        {
          role: 'user',
          content: JSON.stringify(message),
        },
      ],
      structuredOutput: z.object({
        title: z.string(),
      }),
    });

    return object.title;
  }

  getMostRecentUserMessage(messages: Array<CoreMessage>) {
    const userMessages = messages.filter(message => message.role === 'user');
    return userMessages.at(-1);
  }

  async genTitle(userMessage: CoreUserMessage | undefined) {
    let title = 'New Thread';
    try {
      if (userMessage) {
        title = await this.generateTitleFromUserMessage({
          message: userMessage,
        });
      }
    } catch (e) {
      console.error('Error generating title:', e);
    }
    return title;
  }

  async saveMemory({
    threadId,
    memoryConfig,
    resourceId,
    userMessages,
    runId,
  }: {
    resourceId: string;
    threadId?: string;
    memoryConfig?: MemoryConfig;
    userMessages: CoreMessage[];
    time?: Date;
    keyword?: string;
    runId?: string;
  }) {
    const userMessage = this.getMostRecentUserMessage(userMessages);
    if (this.#mastra?.memory) {
      let thread: StorageThreadType | null;
      if (!threadId) {
        this.logger.debug(`No threadId, creating new thread for agent ${this.name}`, {
          runId: runId || this.name,
        });
        const title = await this.genTitle(userMessage);

        thread = await this.#mastra.memory.createThread({
          threadId,
          resourceId,
          title,
        });
      } else {
        thread = await this.#mastra.memory.getThreadById({ threadId });
        if (!thread) {
          this.logger.debug(`Thread not found, creating new thread for agent ${this.name}`, {
            runId: runId || this.name,
          });
          const title = await this.genTitle(userMessage);
          thread = await this.#mastra.memory.createThread({
            threadId,
            resourceId,
            title,
          });
        }
      }

      const newMessages = userMessage ? [userMessage] : userMessages;

      if (thread) {
        const messages = newMessages.map(u => {
          return {
            id: this.#mastra?.memory?.generateId()!,
            createdAt: new Date(),
            threadId: thread.id,
            ...u,
            content: u.content as UserContent | AssistantContent,
            role: u.role as 'user' | 'assistant',
            type: 'text' as 'text' | 'tool-call' | 'tool-result',
          };
        });

        const contextCallMessages: CoreMessage[] = [
          {
            role: 'system',
            content: `\n
             Analyze this message to determine if the user is referring to a previous conversation with the LLM.
             Specifically, identify if the user wants to reference specific information from that chat or if they want the LLM to use the previous chat messages as context for the current conversation.
             Extract any date ranges mentioned in the user message that could help identify the previous chat.
             Return dates in ISO format.
             If no specific dates are mentioned but time periods are (like "last week" or "past month"), calculate the appropriate date range.
             For the end date, return the date 1 day after the end of the time period.
             Today's date is ${new Date().toISOString()}`,
          },
          ...newMessages,
        ];

        let context;

        try {
          context = await this.llm.__textObject<{ usesContext: boolean; startDate: Date; endDate: Date }>({
            messages: contextCallMessages,
            structuredOutput: z.object({
              usesContext: z.boolean(),
              startDate: z.date(),
              endDate: z.date(),
            }),
          });

          this.logger.debug('Text Object result', {
            contextObject: JSON.stringify(context.object, null, 2),
            runId: runId || this.name,
          });
        } catch (e) {
          if (e instanceof Error) {
            this.log(LogLevel.DEBUG, `No context found: ${e.message}`);
          }
        }

        const memoryMessages =
          threadId && this.#mastra.memory
            ? (
                await this.#mastra.memory.rememberMessages({
                  threadId,
                  config: memoryConfig,
                  vectorMessageSearch: messages
                    .slice(-1)
                    .map(m => {
                      if (typeof m === `string`) {
                        return m;
                      }
                      return m?.content || ``;
                    })
                    .join(`\n`),
                })
              ).messages
            : [];

        await this.#mastra.memory.saveMessages({ messages, memoryConfig });

        this.log(LogLevel.DEBUG, 'Saved messages to memory', {
          threadId: thread.id,
          runId,
        });

        return {
          threadId: thread.id,
          messages: [...memoryMessages, ...newMessages],
        };
      }

      return {
        threadId: (thread as StorageThreadType)?.id || threadId || '',
        messages: userMessages,
      };
    }

    return { threadId: threadId || '', messages: userMessages };
  }

  async saveResponse({
    result,
    threadId,
    runId,
    memoryConfig,
  }: {
    runId: string;
    result: Record<string, any>;
    threadId: string;
    memoryConfig: MemoryConfig | undefined;
  }) {
    const { response } = result;
    try {
      if (response.messages) {
        const ms = Array.isArray(response.messages) ? response.messages : [response.messages];

        const responseMessagesWithoutIncompleteToolCalls = this.sanitizeResponseMessages(ms);

        if (this.#mastra?.memory) {
          this.log(LogLevel.DEBUG, 'Saving response to memory', { threadId, runId });

          await this.#mastra.memory.saveMessages({
            memoryConfig,
            messages: responseMessagesWithoutIncompleteToolCalls.map((message: CoreMessage | CoreAssistantMessage) => {
              const messageId = randomUUID();
              let toolCallIds: string[] | undefined;
              let toolCallArgs: Record<string, unknown>[] | undefined;
              let toolNames: string[] | undefined;
              let type: 'text' | 'tool-call' | 'tool-result' = 'text';

              if (message.role === 'tool') {
                toolCallIds = (message as CoreToolMessage).content.map(content => content.toolCallId);
                type = 'tool-result';
              }
              if (message.role === 'assistant') {
                const assistantContent = (message as CoreAssistantMessage).content as Array<TextPart | ToolCallPart>;

                const assistantToolCalls = assistantContent
                  .map(content => {
                    if (content.type === 'tool-call') {
                      return {
                        toolCallId: content.toolCallId,
                        toolArgs: content.args,
                        toolName: content.toolName,
                      };
                    }
                    return undefined;
                  })
                  ?.filter(Boolean) as Array<{
                  toolCallId: string;
                  toolArgs: Record<string, unknown>;
                  toolName: string;
                }>;

                toolCallIds = assistantToolCalls?.map(toolCall => toolCall.toolCallId);

                toolCallArgs = assistantToolCalls?.map(toolCall => toolCall.toolArgs);
                toolNames = assistantToolCalls?.map(toolCall => toolCall.toolName);
                type = assistantContent?.[0]?.type as 'text' | 'tool-call' | 'tool-result';
              }

              return {
                id: messageId,
                threadId: threadId,
                role: message.role as any,
                content: message.content as any,
                createdAt: new Date(),
                toolCallIds: toolCallIds?.length ? toolCallIds : undefined,
                toolCallArgs: toolCallArgs?.length ? toolCallArgs : undefined,
                toolNames: toolNames?.length ? toolNames : undefined,
                type,
              };
            }),
          });
        }
      }
    } catch (err) {
      this.logger.error('Failed to save assistant response', {
        error: err,
        runId: runId,
      });
    }
  }

  sanitizeResponseMessages(
    messages: Array<CoreToolMessage | CoreAssistantMessage>,
  ): Array<CoreToolMessage | CoreAssistantMessage> {
    let toolResultIds: Array<string> = [];

    for (const message of messages) {
      if (message.role === 'tool') {
        for (const content of message.content) {
          if (content.type === 'tool-result') {
            toolResultIds.push(content.toolCallId);
          }
        }
      }
    }

    const messagesBySanitizedContent = messages.map(message => {
      if (message.role !== 'assistant') return message;

      if (typeof message.content === 'string') return message;

      const sanitizedContent = message.content.filter(content =>
        content.type === 'tool-call'
          ? toolResultIds.includes(content.toolCallId)
          : content.type === 'text'
            ? content.text.length > 0
            : true,
      );

      return {
        ...message,
        content: sanitizedContent,
      };
    });

    return messagesBySanitizedContent.filter(message => message.content.length > 0);
  }

  convertTools({
    toolsets,
    // threadId,
    runId,
  }: {
    toolsets?: ToolsetsInput;
    threadId?: string;
    runId?: string;
  }): Record<string, CoreTool> {
    this.logger.debug(`[Agents:${this.name}] - Assigning tools`, { runId });
    const converted = Object.entries(this.tools || {}).reduce(
      (memo, value) => {
        const k = value[0];
        const tool = this.tools[k];

        if (tool) {
          memo[k] = {
            description: tool.description,
            parameters: tool.inputSchema,
            execute: async args => {
              // TODO: tool call cache should be on storage classes, not memory
              // if (threadId && tool.enableCache && this.#mastra?.memory) {
              //   const cachedResult = await this.#mastra.memory.getToolResult({
              //     threadId,
              //     toolArgs: args,
              //     toolName: k as string,
              //   });
              //   if (cachedResult) {
              //     this.logger.debug(`Cached Result ${k as string} runId: ${runId}`, {
              //       cachedResult: JSON.stringify(cachedResult, null, 2),
              //       runId,
              //     });
              //     return cachedResult;
              //   }
              // }
              // this.logger.debug(`Cache not found or not enabled, executing tool runId: ${runId}`, {
              //   runId,
              // });
              return tool.execute({
                context: args,
                mastra: this.#mastra,
              });
            },
          };
        }
        return memo;
      },
      {} as Record<string, CoreTool>,
    );

    const toolsFromToolsetsConverted: Record<string, CoreTool> = {
      ...converted,
    };

    const toolsFromToolsets = Object.values(toolsets || {});

    if (toolsFromToolsets.length > 0) {
      this.logger.debug(`Adding tools from toolsets ${Object.keys(toolsets || {}).join(', ')}`, { runId });
      toolsFromToolsets.forEach(toolset => {
        Object.entries(toolset).forEach(([toolName, tool]) => {
          const toolObj = tool;
          toolsFromToolsetsConverted[toolName] = {
            description: toolObj.description || '',
            parameters: toolObj.inputSchema,
            execute: async args => {
              // TODO: tool call cache should be on storage classes, not memory
              // if (threadId && toolObj.enableCache && this.#mastra?.memory) {
              //   const cachedResult = await this.#mastra.memory.getToolResult({
              //     threadId,
              //     toolArgs: args,
              //     toolName,
              //   });
              //   if (cachedResult) {
              //     this.logger.debug(`Cached Result ${toolName as string} runId: ${runId}`, {
              //       cachedResult: JSON.stringify(cachedResult, null, 2),
              //       runId,
              //     });
              //     return cachedResult;
              //   }
              // }
              // this.logger.debug(`Cache not found or not enabled, executing tool runId: ${runId}`, {
              //   runId,
              // });
              return toolObj.execute!({
                context: args,
              });
            },
          };
        });
      });
    }

    return toolsFromToolsetsConverted;
  }

  async preExecute({
    resourceId,
    runId,
    threadId,
    memoryConfig,
    messages,
  }: {
    runId?: string;
    threadId?: string;
    memoryConfig?: MemoryConfig;
    messages: CoreMessage[];
    resourceId: string;
  }) {
    let coreMessages: CoreMessage[] = [];
    let threadIdToUse = threadId;

    this.log(LogLevel.INFO, `Saving user messages in memory for agent ${this.name}`, { runId });
    const saveMessageResponse = await this.saveMemory({
      threadId,
      resourceId,
      userMessages: messages,
      memoryConfig,
    });

    coreMessages = saveMessageResponse.messages;
    threadIdToUse = saveMessageResponse.threadId;
    return { coreMessages, threadIdToUse };
  }

  __primitive({
    messages,
    context,
    threadId,
    memoryConfig,
    resourceId,
    runId,
    toolsets,
  }: {
    toolsets?: ToolsetsInput;
    resourceId?: string;
    threadId?: string;
    memoryConfig?: MemoryConfig;
    context?: CoreMessage[];
    runId?: string;
    messages: CoreMessage[];
  }) {
    return {
      before: async () => {
        if (process.env.NODE_ENV !== 'test') {
          this.logger.debug(`[Agents:${this.name}] - Starting generation`, { runId });
        }

        const systemMessage: CoreMessage = {
          role: 'system',
          content: `${this.instructions}. Today's date is ${new Date().toISOString()}`,
        };

        let coreMessages = messages;
        let threadIdToUse = threadId;

        if (this.#mastra?.memory && resourceId) {
          const preExecuteResult = await this.preExecute({
            resourceId,
            runId,
            threadId: threadIdToUse,
            memoryConfig,
            messages,
          });

          coreMessages = preExecuteResult.coreMessages;
          threadIdToUse = preExecuteResult.threadIdToUse;
        } else {
          this.logger.debug(
            `[Agents:${this.name}] - No memory store or resourceid identifier found. Skipping memory persistence.`,
            {
              runId,
            },
          );
        }

        let convertedTools: Record<string, CoreTool> | undefined;

        if (
          (toolsets && Object.keys(toolsets || {}).length > 0) ||
          (this.#mastra?.memory && resourceId) ||
          this.#mastra?.engine
        ) {
          convertedTools = this.convertTools({
            toolsets,
            threadId: threadIdToUse,
            runId,
          });
        } else {
          this.logger.debug(`Skipping tool conversion for agent ${this.name}`, {
            runId,
          });
        }

        const messageObjects = [systemMessage, ...(context || []), ...coreMessages];

        return { messageObjects, convertedTools, threadId: threadIdToUse as string };
      },
      after: async ({
        result,
        threadId,
        memoryConfig,
        outputText,
        runId,
      }: {
        runId: string;
        result: Record<string, any>;
        threadId: string;
        memoryConfig: MemoryConfig | undefined;
        outputText: string;
      }) => {
        const resToLog = {
          text: result?.text,
          object: result?.object,
          toolResults: result?.toolResults,
          toolCalls: result?.toolCalls,
          usage: result?.usage,
          steps: result?.steps?.map((s: any) => {
            return {
              stepType: s?.stepType,
              text: result?.text,
              object: result?.object,
              toolResults: result?.toolResults,
              toolCalls: result?.toolCalls,
              usage: result?.usage,
            };
          }),
        };
        this.logger.debug(`[Agent:${this.name}] - Post processing LLM response`, {
          runId,
          result: resToLog,
          threadId,
        });
        if (this.#mastra?.memory && resourceId) {
          try {
            this.logger.debug(`Saving assistant message in memory for agent ${this.name}`, {
              runId,
              threadId,
            });
            await this.saveResponse({
              result,
              threadId,
              memoryConfig,
              runId,
            });
          } catch (e) {
            this.logger.error('Error saving response', {
              error: e,
              runId,
              result: resToLog,
              threadId,
            });
          }
        } else {
          this.logger.debug(
            `[Agents:${this.name}] - No memory store or resourceid identifier found. Skipping memory persistence.`,
            {
              runId,
              threadId,
            },
          );
        }

        if (Object.keys(this.metrics || {}).length > 0) {
          const input = messages.map(message => message.content).join('\n');
          const runIdToUse = runId || crypto.randomUUID();
          for (const metric of Object.values(this.metrics || {})) {
            executeHook(AvailableHooks.ON_GENERATION, {
              input,
              output: outputText,
              runId: runIdToUse,
              metric,
              agentName: this.name,
            });
          }
        }
      },
    };
  }

  async generate<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[],
    {
      context,
      threadId: threadIdInFn,
      thread: memoryConfig,
      resourceId,
      maxSteps = 5,
      onStepFinish,
      runId,
      toolsets,
      output = 'text',
      temperature,
    }: AgentGenerateOptions<Z> = {},
  ): Promise<GenerateReturn<Z>> {
    let messagesToUse: CoreMessage[] = [];

    if (typeof messages === `string`) {
      messagesToUse = [
        {
          role: 'user',
          content: messages,
        },
      ];
    } else {
      messagesToUse = messages.map(message => {
        if (typeof message === `string`) {
          return {
            role: 'user',
            content: message,
          };
        }
        return message;
      });
    }

    const runIdToUse = runId || randomUUID();

    const { before, after } = this.__primitive({
      messages: messagesToUse,
      context,
      threadId: threadIdInFn,
      memoryConfig,
      resourceId,
      runId: runIdToUse,
      toolsets,
    });

    const { threadId, messageObjects, convertedTools } = await before();

    if (output === 'text') {
      const result = await this.llm.__text({
        messages: messageObjects,
        tools: this.tools,
        convertedTools,
        onStepFinish,
        maxSteps,
        runId: runIdToUse,
        temperature,
      });

      const outputText = result.text;

      await after({ result, threadId, memoryConfig, outputText, runId: runIdToUse });

      return result as unknown as GenerateReturn<Z>;
    }

    const result = await this.llm.__textObject({
      messages: messageObjects,
      tools: this.tools,
      structuredOutput: output,
      convertedTools,
      onStepFinish,
      maxSteps,
      runId: runIdToUse,
      temperature,
    });

    const outputText = JSON.stringify(result.object);

    await after({ result, threadId, memoryConfig, outputText, runId: runIdToUse });

    return result as unknown as GenerateReturn<Z>;
  }

  async stream<Z extends ZodSchema | JSONSchema7 | undefined = undefined>(
    messages: string | string[] | CoreMessage[],
    {
      context,
      threadId: threadIdInFn,
      thread: memoryConfig,
      resourceId,
      maxSteps = 5,
      onFinish,
      onStepFinish,
      runId,
      toolsets,
      output = 'text',
      temperature,
    }: AgentStreamOptions<Z> = {},
  ): Promise<StreamReturn<Z>> {
    const runIdToUse = runId || randomUUID();

    let messagesToUse: CoreMessage[] = [];

    if (typeof messages === `string`) {
      messagesToUse = [
        {
          role: 'user',
          content: messages,
        },
      ];
    } else {
      messagesToUse = messages.map(message => {
        if (typeof message === `string`) {
          return {
            role: 'user',
            content: message,
          };
        }
        return message;
      });
    }

    const { before, after } = this.__primitive({
      messages: messagesToUse,
      context,
      threadId: threadIdInFn,
      memoryConfig,
      resourceId,
      runId: runIdToUse,
      toolsets,
    });

    const { threadId, messageObjects, convertedTools } = await before();

    if (output === 'text') {
      this.logger.debug(`Starting agent ${this.name} llm stream call`, {
        runId,
      });
      return this.llm.__stream({
        messages: messageObjects,
        temperature,
        tools: this.tools,
        convertedTools,
        onStepFinish,
        onFinish: async result => {
          try {
            const res = JSON.parse(result) || {};
            const outputText = res.text;
            await after({ result: res, threadId, memoryConfig, outputText, runId: runIdToUse });
          } catch (e) {
            this.logger.error('Error saving memory on finish', {
              error: e,
              runId,
            });
          }
          onFinish?.(result);
        },
        maxSteps,
        runId,
      }) as unknown as StreamReturn<Z>;
    }

    this.logger.debug(`Starting agent ${this.name} llm streamObject call`, {
      runId,
    });
    return this.llm.__streamObject({
      messages: messageObjects,
      tools: this.tools,
      temperature,
      structuredOutput: output,
      convertedTools,
      onStepFinish,
      onFinish: async result => {
        try {
          const res = JSON.parse(result) || {};
          const outputText = JSON.stringify(res.object);
          await after({ result: res, threadId, memoryConfig, outputText, runId: runIdToUse });
        } catch (e) {
          this.logger.error('Error saving memory on finish', {
            error: e,
            runId,
          });
        }
        onFinish?.(result);
      },
      maxSteps,
      runId,
    }) as unknown as StreamReturn<Z>;
  }
}
