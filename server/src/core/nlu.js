import { containerBootstrap } from '@nlpjs/core-loader'
import { Nlp } from '@nlpjs/nlp'
import { BuiltinMicrosoft } from '@nlpjs/builtin-microsoft'
import { LangAll } from '@nlpjs/lang-all'
import request from 'superagent'
import fs from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import kill from 'tree-kill'

import { langs } from '@@/core/langs.json'
import { version } from '@@/package.json'
import Ner from '@/core/ner'
import log from '@/helpers/log'
import string from '@/helpers/string'
import lang from '@/helpers/lang'
import TcpClient from '@/core/tcp-client'
import Conversation from '@/core/conversation'

const defaultNluResultObj = {
  utterance: null,
  currentEntities: [],
  entities: [],
  currentResolvers: [],
  resolvers: [],
  slots: null,
  nluDataFilePath: null,
  answers: [], // For dialog action type
  classification: {
    domain: null,
    skill: null,
    action: null,
    confidence: 0
  }
}

class Nlu {
  constructor (brain) {
    this.brain = brain
    this.request = request
    this.nlp = { }
    this.ner = { }
    this.conv = new Conversation('conv0')
    this.nluResultObj = defaultNluResultObj // TODO

    log.title('NLU')
    log.success('New instance')
  }

  /**
   * Load the NLP model from the latest training
   */
  loadModel (nlpModel) {
    return new Promise(async (resolve, reject) => {
      if (!fs.existsSync(nlpModel)) {
        log.title('NLU')
        reject({ type: 'warning', obj: new Error('The NLP model does not exist, please run: npm run train') })
      } else {
        log.title('NLU')

        try {
          const container = await containerBootstrap()

          container.register('extract-builtin-??', new BuiltinMicrosoft({
            builtins: Ner.getMicrosoftBuiltinEntities()
          }), true)
          container.use(Nlp)
          container.use(LangAll)

          this.nlp = container.get('nlp')
          const nluManager = container.get('nlu-manager')
          nluManager.settings.spellCheck = true

          await this.nlp.load(nlpModel)
          log.success('NLP model loaded')

          this.ner = new Ner(this.nlp.ner)

          resolve()
        } catch (err) {
          this.brain.talk(`${this.brain.wernicke('random_errors')}! ${this.brain.wernicke('errors', 'nlu', { '%error%': err.message })}.`)
          this.brain.socket.emit('is-typing', false)

          reject({ type: 'error', obj: err })
        }
      }
    })
  }

  /**
   * Check if the NLP model exists
   */
  hasNlpModel () {
    return Object.keys(this.nlp).length > 0
  }

  /**
   * Set new language; recreate a new TCP server with new language; and reprocess understanding
   */
  switchlanguage (utterance, locale, opts) {
    const connectedHandler = async () => {
      await this.process(utterance, opts)
    }

    this.brain.lang = locale
    this.brain.talk(`${this.brain.wernicke('random_language_switch')}.`, true)

    // Recreate a new TCP server process and reconnect the TCP client
    kill(global.tcpServerProcess.pid, () => {
      global.tcpServerProcess = spawn(`pipenv run python bridges/python/tcp_server/main.py ${locale}`, { shell: true })

      global.tcpClient = new TcpClient(
        process.env.LEON_PY_TCP_SERVER_HOST,
        process.env.LEON_PY_TCP_SERVER_PORT
      )

      global.tcpClient.ee.removeListener('connected', connectedHandler)
      global.tcpClient.ee.on('connected', connectedHandler)
    })

    return { }
  }

  /**
   * Collaborative logger request
   */
  sendLog (utterance) {
    /* istanbul ignore next */
    if (process.env.LEON_LOGGER === 'true' && process.env.LEON_NODE_ENV !== 'testing') {
      this.request
        .post('https://logger.getleon.ai/v1/expressions')
        .set('X-Origin', 'leon-core')
        .send({
          version,
          utterance,
          lang: this.brain.lang,
          classification: this.nluResultObj.classification
        })
        .then(() => { /* */ })
        .catch(() => { /* */ })
    }
  }

  /**
   * Merge spaCy entities with the current NER instance
   */
  async mergeSpacyEntities (utterance) {
    const spacyEntities = await Ner.getSpacyEntities(utterance)
    if (spacyEntities.length > 0) {
      spacyEntities.forEach(({ entity, resolution }) => {
        const spacyEntity = {
          [entity]: {
            options: {
              [resolution.value]: [resolution.value]
            }
          }
        }

        this.nlp.addEntities(spacyEntity, this.brain.lang)
      })
    }
  }

  /**
   * Handle in action loop logic before NLU processing
   */
  async handleActionLoop (utterance, opts) {
    const { domain, intent } = this.conv.activeContext
    const [skillName, actionName] = intent.split('.')
    const nluDataFilePath = join(process.cwd(), 'skills', domain, skillName, `nlu/${this.brain.lang}.json`)
    this.nluResultObj = {
      ...this.nluResultObj,
      slots: this.conv.activeContext.slots,
      utterance,
      nluDataFilePath,
      classification: {
        domain,
        skill: skillName,
        action: actionName,
        confidence: 1
      }
    }
    this.nluResultObj.entities = await this.ner.extractEntities(
      this.brain.lang,
      nluDataFilePath,
      this.nluResultObj
    )

    const processedData = await this.brain.execute(this.nluResultObj, { mute: opts.mute })
    console.log('processedData', processedData)
    const { name: expectedItemName, type: expectedItemType } = processedData
      .action.loop.expected_item
    let hasMatchingEntity = false
    let hasMatchingResolver = false

    console.log('expectedItemName', expectedItemName)
    if (expectedItemType === 'entity') {
      hasMatchingEntity = processedData
        .entities.filter(({ entity }) => expectedItemName === entity)
    } else if (expectedItemType === 'resolver') {
      const { intent } = await this.nlp.process(utterance)
      const resolveResolvers = (resolver, intent) => {
        const resolversPath = join(process.cwd(), 'core/data', this.brain.lang, 'resolvers')
        const { intents } = JSON.parse(fs.readFileSync(join(resolversPath, `${resolver}.json`)))

        return [{
          name: expectedItemName,
          value: intents[intent].value
        }]
      }

      // TODO: understand why the resolvers aren't correctly resolved on the Python side

      console.log('INTENT', intent)
      this.nluResultObj.resolvers = resolveResolvers(expectedItemName, intent)

      hasMatchingResolver = this.nluResultObj.resolvers.length > 0
      // await this.process(utterance, opts)
    }

    console.log('this.nluResultObj.resolvers', this.nluResultObj.resolvers)

    // Ensure expected items are in the utterance, otherwise clean context and reprocess
    if (!hasMatchingEntity && !hasMatchingResolver) {
      this.brain.talk(`${this.brain.wernicke('random_context_out_of_topic')}.`)
      this.conv.cleanActiveContext()
      await this.process(utterance, opts)
      return null
    }

    // Reprocess with the original utterance that triggered the context at first
    if (processedData.core?.restart === true) {
      const { originalUtterance } = this.conv.activeContext

      this.conv.cleanActiveContext()
      await this.process(originalUtterance, opts)
      return null
    }

    // In case there is no next action to prepare anymore
    if (!processedData.action.next_action) {
      this.conv.cleanActiveContext()
      return null
    }

    // Break the action loop and prepare for the next action if necessary
    if (processedData.core?.isInActionLoop === false) {
      this.conv.activeContext.isInActionLoop = !!processedData.action.loop
      this.conv.activeContext.actionName = processedData.action.next_action
      this.conv.activeContext.intent = `${processedData.classification.skill}.${processedData.action.next_action}`
    }

    return processedData
  }

  /**
   * Handle slot filling
   */
  async handleSlotFilling (utterance, opts) {
    const processedData = await this.slotFill(utterance, opts)
    console.log('processedData (slot filled over)', processedData)

    /**
     * In case the slot filling has been interrupted. e.g. context change, etc.
     * Then reprocess with the new utterance
     */
    if (!processedData) {
      await this.process(utterance, opts)
      return null
    }

    if (processedData && Object.keys(processedData).length > 0) {
      // Set new context with the next action if there is one
      if (processedData.action.next_action) {
        this.conv.activeContext = {
          lang: this.brain.lang,
          slots: { },
          isInActionLoop: !!processedData.nextAction.loop,
          originalUtterance: processedData.utterance,
          nluDataFilePath: processedData.nluDataFilePath,
          actionName: processedData.action.next_action,
          domain: processedData.classification.domain,
          intent: `${processedData.classification.skill}.${processedData.action.next_action}`,
          entities: []
        }

        console.log('NEW ACTIVE CONTEXT', this.conv.activeContext)
      }
    }

    return processedData
  }

  /**
   * Classify the utterance,
   * pick-up the right classification
   * and extract entities
   */
  process (utterance, opts) {
    console.log('process() start this.conv.activeContext', this.conv.activeContext)
    const processingTimeStart = Date.now()

    return new Promise(async (resolve, reject) => {
      log.title('NLU')
      log.info('Processing...')

      opts = opts || {
        mute: false // Close Leon mouth e.g. over HTTP
      }
      utterance = string.ucfirst(utterance)

      if (!this.hasNlpModel()) {
        if (!opts.mute) {
          this.brain.talk(`${this.brain.wernicke('random_errors')}!`)
          this.brain.socket.emit('is-typing', false)
        }

        const msg = 'The NLP model is missing, please rebuild the project or if you are in dev run: npm run train'
        log.error(msg)
        return reject(msg)
      }

      // Add spaCy entities
      await this.mergeSpacyEntities(utterance)

      // Pre NLU processing according to the active context if there is one
      if (this.conv.hasActiveContext()) {
        // When the active context is in an action loop, then directly trigger the action
        if (this.conv.activeContext.isInActionLoop) {
          return resolve(await this.handleActionLoop(utterance, opts))
        }

        // When the active context has slots filled
        if (Object.keys(this.conv.activeContext.slots).length > 0) {
          return resolve(await this.handleSlotFilling(utterance, opts))
        }
      }

      const result = await this.nlp.process(utterance)
      const {
        locale, answers, classifications
      } = result
      let { score, intent, domain } = result

      /**
       * If a context is active, then use the appropriate classification based on score probability.
       * E.g. 1. Create my shopping list; 2. Actually delete it.
       * If there are several "delete it" across skills, Leon needs to make use of
       * the current context ({domain}.{skill}) to define the most accurate classification
       */
      if (this.conv.hasActiveContext()) {
        classifications.forEach(({ intent: newIntent, score: newScore }) => {
          if (newScore > 0.6) {
            const [skillName] = newIntent.split('.')
            const newDomain = this.nlp.getIntentDomain(locale, newIntent)
            const contextName = `${newDomain}.${skillName}`
            if (this.conv.activeContext.name === contextName) {
              score = newScore
              intent = newIntent
              domain = newDomain
            }
          }
        })
      }

      const [skillName, actionName] = intent.split('.')
      this.nluResultObj = {
        ...this.nluResultObj,
        utterance,
        answers, // For dialog action type
        classification: {
          domain,
          skill: skillName,
          action: actionName,
          confidence: score
        }
      }

      // Language isn't supported
      if (!lang.getShortLangs().includes(locale)) {
        this.brain.talk(`${this.brain.wernicke('random_language_not_supported')}.`, true)
        this.brain.socket.emit('is-typing', false)
        return resolve({ })
      }

      // Trigger language switching
      if (this.brain.lang !== locale) {
        return resolve(this.switchlanguage(utterance, locale, opts))
      }

      this.sendLog()

      if (intent === 'None') {
        const fallback = this.fallback(langs[lang.getLongCode(locale)].fallbacks)

        if (fallback === false) {
          if (!opts.mute) {
            this.brain.talk(`${this.brain.wernicke('random_unknown_intents')}.`, true)
            this.brain.socket.emit('is-typing', false)
          }

          log.title('NLU')
          const msg = 'Intent not found'
          log.warning(msg)

          const processingTimeEnd = Date.now()
          const processingTime = processingTimeEnd - processingTimeStart

          return resolve({
            processingTime,
            message: msg
          })
        }

        this.nluResultObj = fallback
      }

      log.title('NLU')
      log.success(`Intent found: ${this.nluResultObj.classification.skill}.${this.nluResultObj.classification.action} (domain: ${this.nluResultObj.classification.domain})`)

      const nluDataFilePath = join(process.cwd(), 'skills', this.nluResultObj.classification.domain, this.nluResultObj.classification.skill, `nlu/${this.brain.lang}.json`)
      this.nluResultObj.nluDataFilePath = nluDataFilePath

      try {
        this.nluResultObj.entities = await this.ner.extractEntities(
          this.brain.lang,
          nluDataFilePath,
          this.nluResultObj
        )
      } catch (e) /* istanbul ignore next */ {
        if (log[e.type]) {
          log[e.type](e.obj.message)
        }

        if (!opts.mute) {
          this.brain.talk(`${this.brain.wernicke(e.code, '', e.data)}!`)
        }
      }

      const shouldSlotLoop = await this.routeSlotFilling(intent)
      if (shouldSlotLoop) {
        return resolve({ })
      }

      // In case all slots have been filled in the first utterance
      if (this.conv.hasActiveContext() && Object.keys(this.conv.activeContext.slots).length > 0) {
        return resolve(await this.handleSlotFilling(utterance, opts))
      }

      const newContextName = `${this.nluResultObj.classification.domain}.${skillName}`
      if (this.conv.activeContext.name !== newContextName) {
        this.conv.cleanActiveContext()
      }
      this.conv.activeContext = {
        lang: this.brain.lang,
        slots: { },
        isInActionLoop: false,
        originalUtterance: this.nluResultObj.utterance,
        nluDataFilePath: this.nluResultObj.nluDataFilePath,
        actionName: this.nluResultObj.classification.action,
        domain: this.nluResultObj.classification.domain,
        intent,
        entities: this.nluResultObj.entities
      }
      // Pass current utterance entities to the NLU result object
      this.nluResultObj.currentEntities = this.conv.activeContext.currentEntities
      // Pass context entities to the NLU result object
      this.nluResultObj.entities = this.conv.activeContext.entities

      try {
        const processedData = await this.brain.execute(this.nluResultObj, { mute: opts.mute })

        // Prepare next action if there is one queuing
        if (processedData.nextAction) {
          this.conv.cleanActiveContext()
          this.conv.activeContext = {
            lang: this.brain.lang,
            slots: { },
            isInActionLoop: !!processedData.nextAction.loop,
            originalUtterance: processedData.utterance,
            nluDataFilePath: processedData.nluDataFilePath,
            actionName: processedData.action.next_action,
            domain: processedData.classification.domain,
            intent: `${processedData.classification.skill}.${processedData.action.next_action}`,
            entities: []
          }
        }

        console.log('final this.conv.activeContext', this.conv.activeContext)

        const processingTimeEnd = Date.now()
        const processingTime = processingTimeEnd - processingTimeStart

        return resolve({
          processingTime, // In ms, total time
          ...processedData,
          nluProcessingTime:
            processingTime - processedData?.executionTime // In ms, NLU processing time only
        })
      } catch (e) /* istanbul ignore next */ {
        log[e.type](e.obj.message)

        if (!opts.mute) {
          this.brain.socket.emit('is-typing', false)
        }

        return reject(e.obj)
      }
    })
  }

  /**
   * Build NLU data result object based on slots
   * and ask for more entities if necessary
   */
  async slotFill (utterance, opts) {
    if (!this.conv.activeContext.nextAction) {
      return null
    }

    const { domain, intent } = this.conv.activeContext
    const [skillName, actionName] = intent.split('.')
    const nluDataFilePath = join(process.cwd(), 'skills', domain, skillName, `nlu/${this.brain.lang}.json`)

    this.nluResultObj = {
      ...this.nluResultObj,
      utterance,
      classification: {
        domain,
        skill: skillName,
        action: actionName
      }
    }
    const entities = await this.ner.extractEntities(
      this.brain.lang,
      nluDataFilePath,
      this.nluResultObj
    )

    // Continue to loop for questions if a slot has been filled correctly
    let notFilledSlot = this.conv.getNotFilledSlot()
    if (notFilledSlot && entities.length > 0) {
      const hasMatch = entities.some(({ entity }) => entity === notFilledSlot.expectedEntity)

      if (hasMatch) {
        this.conv.setSlots(this.brain.lang, entities)

        notFilledSlot = this.conv.getNotFilledSlot()
        if (notFilledSlot && entities.length > 0) {
          this.brain.talk(notFilledSlot.pickedQuestion)
          this.brain.socket.emit('is-typing', false)

          return { }
        }
      }
    }

    if (!this.conv.areSlotsAllFilled()) {
      this.brain.talk(`${this.brain.wernicke('random_context_out_of_topic')}.`)
    } else {
      /**
       * TODO:
       * 1. [OK] Extract entities from utterance
       * 2. [OK] If none of them match any slot in the active context, then continue
       * 3. [OK] If an entity match slot in active context, then fill it
       * 4. [OK] Move skill type to action type
       * 5.1 [OK] In Conversation, need to chain output/input contexts to each other
       * to understand what action should be next
       * 5.2 [OK] Execute next action (based on input_context?)
       * 5.3 [OK] Need to handle the case if a context is filled in one shot
       * e.g. I wanna play with 2 players and louis.grenard@gmail.com
       * Need to refactor now (nluResultObj method to build it, etc.)
       * 6. [OK] Handle a "loop" feature from action (guess the number)
       * 7. [OK] While in an action loop, if something other than an expected entity is sent
       * then break the loop. Need "loop" object in NLU skill config to describe
       * 8. [OK] Replay with the original utterance
       * 9. [OK] Be able to use the loop without necessarily need slots
       * 10. [OK] Split this process() method into several ones + clean nlu.js and brain.js
       * 11. Add logs in terminal about context switching, active context, etc.
       */

      this.nluResultObj = {
        ...this.nluResultObj,
        // Assign slots only if there is a next action
        slots: this.conv.activeContext.nextAction ? this.conv.activeContext.slots : { },
        utterance: this.conv.activeContext.originalUtterance,
        nluDataFilePath,
        classification: {
          domain,
          skill: skillName,
          action: this.conv.activeContext.nextAction,
          confidence: 1
        }
      }

      console.log('this.conv.activeContext just before execute', this.conv.activeContext)
      console.log('this.nluResultObj just before execute', this.nluResultObj)

      this.conv.cleanActiveContext()

      return this.brain.execute(this.nluResultObj, { mute: opts.mute })
    }

    this.conv.cleanActiveContext()
    return null
  }

  /**
   * Decide what to do with slot filling.
   * 1. Activate context
   * 2. If the context is expecting slots, then loop over questions to slot fill
   * 3. Or go to the brain executor if all slots have been filled in one shot
   */
  async routeSlotFilling (intent) {
    const slots = await this.nlp.slotManager.getMandatorySlots(intent)
    const hasMandatorySlots = Object.keys(slots)?.length > 0

    if (hasMandatorySlots) {
      this.conv.activeContext = {
        lang: this.brain.lang,
        slots,
        isInActionLoop: false,
        originalUtterance: this.nluResultObj.utterance,
        nluDataFilePath: this.nluResultObj.nluDataFilePath,
        actionName: this.nluResultObj.classification.action,
        domain: this.nluResultObj.classification.domain,
        intent,
        entities: this.nluResultObj.entities
      }

      const notFilledSlot = this.conv.getNotFilledSlot()
      // Loop for questions if a slot hasn't been filled
      if (notFilledSlot) {
        this.brain.talk(notFilledSlot.pickedQuestion)
        this.brain.socket.emit('is-typing', false)

        return true
      }
    }

    return false
  }

  /**
   * Pickup and compare the right fallback
   * according to the wished skill action
   */
  fallback (fallbacks) {
    const words = this.nluResultObj.utterance.toLowerCase().split(' ')

    if (fallbacks.length > 0) {
      log.info('Looking for fallbacks...')
      const tmpWords = []

      for (let i = 0; i < fallbacks.length; i += 1) {
        for (let j = 0; j < fallbacks[i].words.length; j += 1) {
          if (words.includes(fallbacks[i].words[j]) === true) {
            tmpWords.push(fallbacks[i].words[j])
          }
        }

        if (JSON.stringify(tmpWords) === JSON.stringify(fallbacks[i].words)) {
          this.nluResultObj.entities = []
          this.nluResultObj.classification.domain = fallbacks[i].domain
          this.nluResultObj.classification.skill = fallbacks[i].skill
          this.nluResultObj.classification.action = fallbacks[i].action
          this.nluResultObj.classification.confidence = 1

          log.success('Fallback found')
          return this.nluResultObj
        }
      }
    }

    return false
  }
}

export default Nlu
