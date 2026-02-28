/**
 * src/openai.js - Cliente para API OpenAI/ChatGPT
 * Versão 2.0 - Com retry, timeout e validações
 */

const https = require('https');
const { createLogger } = require('./logger');

const logger = createLogger('OPENAI');

const DEFAULT_TIMEOUT = 60000; // 60 segundos
const MAX_RETRIES = 2;
const RETRY_DELAY = 2000; // 2 segundos

/**
 * Aguarda X milissegundos
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Faz requisição para API OpenAI Chat Completion
 * @param {Object} params
 * @param {string} params.apiKey - API key da OpenAI
 * @param {string} params.model - Modelo a usar (ex: gpt-4o-mini)
 * @param {Array} params.messages - Array de mensagens {role, content}
 * @param {number} params.maxTokens - Máximo de tokens na resposta
 * @param {number} params.temperature - Temperatura (0-2), default 0.7
 * @param {number} params.timeout - Timeout em ms, default 60000
 * @returns {Promise<{ok: boolean, text: string, usage?: object, error?: string}>}
 */
async function chatComplete({ 
  apiKey, 
  model, 
  messages, 
  maxTokens = 1000, 
  temperature = 0.7,
  timeout = DEFAULT_TIMEOUT 
}) {
  // Validações
  if (!apiKey) {
    logger.error('API key não configurada');
    return { ok: false, text: '', error: 'API key não configurada' };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    logger.error('Messages inválido');
    return { ok: false, text: '', error: 'Messages deve ser array não vazio' };
  }

  // Tenta até MAX_RETRIES vezes
  let lastError = null;
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      logger.info(`Tentativa ${attempt}/${MAX_RETRIES} - Chamando OpenAI API...`);
      
      const result = await makeRequest({
        apiKey,
        model: model || 'gpt-4o-mini',
        messages,
        maxTokens,
        temperature,
        timeout
      });

      if (result.ok) {
        logger.info(`✅ Resposta recebida (${result.usage?.total_tokens || 0} tokens)`);
        return result;
      }

      lastError = result.error;

      // Se for erro 429 (rate limit) ou 5xx, tenta novamente
      if (result.retryable && attempt < MAX_RETRIES) {
        logger.warn(`Erro retryable: ${result.error}, aguardando ${RETRY_DELAY}ms...`);
        await sleep(RETRY_DELAY * attempt);
        continue;
      }

      // Erro não retryable, retorna imediatamente
      return result;

    } catch (err) {
      lastError = err.message;
      logger.error(`Tentativa ${attempt} falhou:`, err.message);
      
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY * attempt);
      }
    }
  }

  logger.error(`Todas as ${MAX_RETRIES} tentativas falharam`);
  return { 
    ok: false, 
    text: '', 
    error: lastError || 'Todas as tentativas falharam' 
  };
}

/**
 * Faz a requisição HTTP para OpenAI
 */
function makeRequest({ apiKey, model, messages, maxTokens, temperature, timeout }) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: model,
      messages: messages,
      max_tokens: maxTokens,
      temperature: temperature
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${apiKey}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          // Sucesso
          if (res.statusCode === 200) {
            const text = json.choices?.[0]?.message?.content || '';
            const usage = json.usage;

            return resolve({
              ok: true,
              text: text,
              usage: usage,
              retryable: false
            });
          }

          // Erros
          const errorMessage = json.error?.message || `HTTP ${res.statusCode}`;
          const errorType = json.error?.type || 'unknown';
          
          // Determina se é retryable
          const retryable = (
            res.statusCode === 429 || // Rate limit
            res.statusCode >= 500      // Server errors
          );

          logger.error(`OpenAI API erro [${res.statusCode}]: ${errorMessage}`);

          return resolve({
            ok: false,
            text: '',
            error: errorMessage,
            errorType: errorType,
            retryable: retryable
          });

        } catch (err) {
          logger.error('Erro ao parsear resposta JSON:', err.message);
          return resolve({
            ok: false,
            text: '',
            error: 'Erro ao processar resposta da API',
            retryable: false
          });
        }
      });
    });

    // Timeout
    req.setTimeout(timeout, () => {
      req.destroy();
      logger.error(`Timeout após ${timeout}ms`);
      resolve({
        ok: false,
        text: '',
        error: `Timeout: API não respondeu em ${timeout / 1000}s`,
        retryable: true
      });
    });

    // Erro de rede
    req.on('error', (err) => {
      logger.error('Erro de rede:', err.message);
      resolve({
        ok: false,
        text: '',
        error: `Erro de rede: ${err.message}`,
        retryable: true
      });
    });

    req.write(payload);
    req.end();
  });
}

/**
 * Valida se a API key está funcionando
 * @param {string} apiKey - API key da OpenAI
 * @returns {Promise<boolean>}
 */
async function validateApiKey(apiKey) {
  logger.info('Validando API key...');
  
  const result = await chatComplete({
    apiKey,
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: 'test' }],
    maxTokens: 5,
    timeout: 10000 // 10 segundos para validação
  });

  if (result.ok) {
    logger.info('✅ API key válida');
    return true;
  } else {
    logger.error('❌ API key inválida:', result.error);
    return false;
  }
}

module.exports = { chatComplete, validateApiKey };
