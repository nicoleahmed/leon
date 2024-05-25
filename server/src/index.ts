import { spawn } from 'node:child_process'
import fs from 'node:fs'

import psList from 'ps-list'
import kill from 'tree-kill'

import {
  IS_DEVELOPMENT_ENV,
  IS_PRODUCTION_ENV,
  IS_TELEMETRY_ENABLED,
  LANG as LEON_LANG,
  PYTHON_TCP_SERVER_BIN_PATH
} from '@/constants'
import {
  PYTHON_TCP_CLIENT,
  HTTP_SERVER,
  SOCKET_SERVER,
  LLM_PROVIDER,
  LLM_MANAGER
} from '@/core'
import { Updater } from '@/updater'
import { Telemetry } from '@/telemetry'
// import { CustomNERLLMDuty } from '@/core/llm-manager/llm-duties/custom-ner-llm-duty'
// import { SummarizationLLMDuty } from '@/core/llm-manager/llm-duties/summarization-llm-duty'
// import { TranslationLLMDuty } from '@/core/llm-manager/llm-duties/translation-llm-duty'
// import { ParaphraseLLMDuty } from '@/core/llm-manager/llm-duties/paraphrase-llm-duty'
// import { ActionRecognitionLLMDuty } from '@/core/llm-manager/llm-duties/action-recognition-llm-duty'
import { LangHelper } from '@/helpers/lang-helper'
import { LogHelper } from '@/helpers/log-helper'
;(async (): Promise<void> => {
  process.title = 'leon'

  // Kill any existing Leon process before starting a new one
  const processList = await psList()
  processList
    .filter(
      (p) =>
        p.cmd?.includes(PYTHON_TCP_SERVER_BIN_PATH) ||
        (p.cmd === process.title && p.pid !== process.pid)
    )
    .forEach((p) => {
      kill(p.pid)
      LogHelper.info(`Killed existing Leon process: ${p.pid}`)
    })

  // Start the Python TCP server
  global.pythonTCPServerProcess = spawn(
    `${PYTHON_TCP_SERVER_BIN_PATH} ${LangHelper.getShortCode(LEON_LANG)}`,
    {
      shell: true,
      detached: IS_DEVELOPMENT_ENV
    }
  )
  global.pythonTCPServerProcess.stdout.on('data', (data: Buffer) => {
    LogHelper.title('Python TCP Server')
    LogHelper.info(data.toString())
  })
  global.pythonTCPServerProcess.stderr.on('data', (data: Buffer) => {
    const formattedData = data.toString().trim()
    const skipError = [
      'RuntimeWarning:',
      'FutureWarning:',
      'UserWarning:',
      '<00:00',
      '00:00<',
      'CUDNN_STATUS_NOT_SUPPORTED',
      'cls.seq_relationship.weight',
      'ALSA lib'
    ]

    if (skipError.some((error) => formattedData.includes(error))) {
      return
    }

    LogHelper.title('Python TCP Server')
    LogHelper.error(data.toString())
  })

  // Connect the Python TCP client to the Python TCP server
  PYTHON_TCP_CLIENT.connect()

  try {
    await LLM_PROVIDER.init()
  } catch (e) {
    LogHelper.error(`LLM Provider failed to init: ${e}`)
  }

  try {
    await LLM_MANAGER.loadLLM()
  } catch (e) {
    LogHelper.error(`LLM Manager failed to load: ${e}`)
  }

  /*const actionRecognitionDuty = new ActionRecognitionLLMDuty({
    input: 'Give me a random number'
  })
  await actionRecognitionDuty.execute()*/

  /*const customNERDuty = new CustomNERLLMDuty({
    input:
      'Add apples, 1L of milk, orange juice and tissues to the shopping list',
    data: {
      schema: {
        items: {
          type: 'array',
          items: {
            type: 'string'
          }
        },
        list_name: {
          type: 'string'
        }
      }
    }
  })
  await customNERDuty.execute()*/

  /*const summarizationDuty = new SummarizationLLMDuty({
    input:
      'We’ll be taking several important safety steps ahead of making Sora available in OpenAI’s products. We are working with red teamers domain experts in areas like misinformation, hateful content, and bias who will be adversarially testing the model.\n' +
      '\n' +
      'We’re also building tools to help detect misleading content such as a detection classifier that can tell when a video was generated by Sora. We plan to include C2PA metadata in the future if we deploy the model in an OpenAI product.\n' +
      '\n' +
      'In addition to us developing new techniques to prepare for deployment, we’re leveraging the existing safety methods that we built for our products that use DALL·E 3, which are applicable to Sora as well.\n' +
      '\n' +
      'For example, once in an OpenAI product, our text classifier will check and reject text input prompts that are in violation of our usage policies, like those that request extreme violence, sexual content, hateful imagery, celebrity likeness, or the IP of others. We’ve also developed robust image classifiers that are used to review the frames of every video generated to help ensure that it adheres to our usage policies, before it’s shown to the user.\n' +
      '\n' +
      'We’ll be engaging policymakers, educators and artists around the world to understand their concerns and to identify positive use cases for this new technology. Despite extensive research and testing, we cannot predict all of the beneficial ways people will use our technology, nor all the ways people will abuse it. That’s why we believe that learning from real-world use is a critical component of creating and releasing increasingly safe AI systems over time.'
  })
  await summarizationDuty.execute()*/

  /*const paraphraseDuty = new ParaphraseLLMDuty({
    input: 'I added your items to the shopping list.'
  })
  await paraphraseDuty.execute()*/

  /*const translationDuty = new TranslationLLMDuty({
    input: 'the weather is good in shenzhen',
    data: {
      // source: 'French',
      target: 'French',
      autoDetectLanguage: true
    }
  })
  await translationDuty.execute()*/

  try {
    // Start the HTTP server
    await HTTP_SERVER.init()
  } catch (e) {
    LogHelper.error(`HTTP server failed to init: ${e}`)
  }

  // TODO
  // Register HTTP API endpoints
  // await HTTP_API.register()

  // Start the socket server
  SOCKET_SERVER.init()

  // Check for updates on startup and every 24 hours
  if (IS_PRODUCTION_ENV) {
    Updater.checkForUpdates()
    setInterval(
      () => {
        Updater.checkForUpdates()
      },
      1_000 * 3_600 * 24
    )
  }

  // Telemetry events
  if (IS_TELEMETRY_ENABLED) {
    Telemetry.start()

    // Watch for errors in the error log file and report them to the telemetry service
    fs.watchFile(LogHelper.ERRORS_FILE_PATH, async () => {
      const logErrors = await LogHelper.parseErrorLogs()
      const lastError = logErrors[logErrors.length - 1] || ''

      Telemetry.error(lastError)
    })

    setInterval(
      () => {
        Telemetry.heartbeat()
      },
      1_000 * 3_600 * 6
    )
  }
  ;[
    'exit',
    'SIGINT',
    'SIGUSR1',
    'SIGUSR2',
    'uncaughtException',
    'SIGTERM',
    'SIGHUP'
  ].forEach((eventType) => {
    process.on(eventType, () => {
      kill(global.pythonTCPServerProcess.pid as number)

      if (IS_TELEMETRY_ENABLED) {
        Telemetry.stop()
      }

      setTimeout(() => {
        process.exit(0)
      }, 1_000)
    })
  })
})()
