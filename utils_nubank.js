/**
 * src/utils_nubank.js - Parser de CSV do Nubank
 * Versão 2.0 - Com validações robustas e tratamento de erros
 */

const { createLogger } = require('./logger');

const logger = createLogger('NUBANK');

/**
 * Faz parse de buffer CSV do Nubank
 * @param {Buffer} buffer - Buffer contendo o CSV
 * @returns {Array<Object>} Array de transações parseadas
 */
function parseNubankCsvBuffer(buffer) {
  try {
    if (!Buffer.isBuffer(buffer)) {
      throw new Error('Input deve ser um Buffer');
    }

    const text = buffer.toString('utf-8');
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);

    if (lines.length === 0) {
      logger.warn('CSV vazio');
      return [];
    }

    if (lines.length === 1) {
      logger.warn('CSV contém apenas header, sem dados');
      return [];
    }

    // Primeira linha é o header
    const header = parseCSVLine(lines[0]).map(h => h.trim().replace(/"/g, ''));
    
    logger.info(`Header encontrado: ${header.join(', ')}`);
    logger.info(`Total de linhas de dados: ${lines.length - 1}`);

    const transactions = [];
    let skippedLines = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      
      try {
        const values = parseCSVLine(line);

        if (values.length !== header.length) {
          logger.warn(`Linha ${i + 1}: número de colunas incorreto (esperado ${header.length}, encontrado ${values.length}), pulando`);
          skippedLines++;
          continue;
        }

        // Monta objeto com colunas
        const row = {};
        header.forEach((col, idx) => {
          row[col] = values[idx];
        });

        // Converte para formato interno
        const tx = parseNubankRow(row);
        
        if (tx) {
          transactions.push(tx);
        } else {
          logger.warn(`Linha ${i + 1}: transação inválida, pulando`);
          skippedLines++;
        }

      } catch (err) {
        logger.error(`Erro ao processar linha ${i + 1}:`, err.message);
        skippedLines++;
      }
    }

    logger.info(`✅ Parser concluído: ${transactions.length} transações válidas, ${skippedLines} linhas puladas`);
    
    return transactions;

  } catch (err) {
    logger.error('Erro fatal ao parsear CSV:', err.message);
    throw err;
  }
}

/**
 * Faz parse de uma linha CSV respeitando aspas
 * @param {string} line - Linha do CSV
 * @returns {Array<string>}
 */
function parseCSVLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        // Aspas duplicadas dentro de campo quoted (escape)
        current += '"';
        i++; // Skip próximo char
      } else {
        // Toggle estado de quotes
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      // Fim do campo
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  // Adiciona último campo
  values.push(current.trim());

  return values;
}

/**
 * Converte linha do Nubank para formato interno
 * @param {Object} row - Objeto com colunas do CSV
 * @returns {Object|null} Transação formatada ou null se inválida
 */
function parseNubankRow(row) {
  try {
    // Possíveis nomes de colunas (Nubank muda às vezes)
    const dateCol = findColumn(row, ['Data', 'date', 'Data da transação', 'Data da compra']);
    const descCol = findColumn(row, ['Descrição', 'description', 'Descrição da transação', 'Estabelecimento']);
    const amountCol = findColumn(row, ['Valor', 'amount', 'Valor da transação']);
    const categoryCol = findColumn(row, ['Categoria', 'category', 'Categoria da transação']);

    if (!dateCol || !amountCol) {
      logger.warn('Linha sem data ou valor, ignorando');
      return null;
    }

    // Parse data
    const txDate = parseDate(dateCol);
    if (!txDate) {
      logger.warn(`Data inválida: "${dateCol}"`);
      return null;
    }

    // Parse valor
    const { amount, direction } = parseAmount(amountCol);
    if (amount === 0) {
      logger.warn(`Valor zero ou inválido: "${amountCol}"`);
      // Não retorna null, pois pode ser transação válida de R$ 0,00
    }

    return {
      tx_date: txDate,
      description: cleanString(descCol),
      category: cleanString(categoryCol) || null,
      amount_cents: amount,
      direction: direction,
      raw: row
    };

  } catch (err) {
    logger.error('Erro ao processar linha:', err.message);
    return null;
  }
}

/**
 * Busca coluna por possíveis nomes
 */
function findColumn(row, possibleNames) {
  for (const name of possibleNames) {
    if (row[name] !== undefined && row[name] !== null) {
      return row[name];
    }
  }
  return '';
}

/**
 * Limpa string removendo aspas e espaços extras
 */
function cleanString(str) {
  if (!str) return '';
  return String(str)
    .replace(/^["']+|["']+$/g, '') // Remove aspas nas pontas
    .trim();
}

/**
 * Faz parse de data em vários formatos
 * @param {string} dateStr - String de data
 * @returns {string|null} Data em formato ISO (YYYY-MM-DD) ou null
 */
function parseDate(dateStr) {
  if (!dateStr) return null;

  const cleaned = dateStr.trim();

  // Formato DD/MM/YYYY
  const ddmmyyyyMatch = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (ddmmyyyyMatch) {
    const [, day, month, year] = ddmmyyyyMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Formato YYYY-MM-DD (já ISO)
  const isoMatch = cleaned.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Formato DD-MM-YYYY
  const ddmmyyyyDashMatch = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyyDashMatch) {
    const [, day, month, year] = ddmmyyyyDashMatch;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  logger.warn(`Formato de data não reconhecido: "${cleaned}"`);
  return null;
}

/**
 * Faz parse de valor monetário
 * @param {string} amountStr - String de valor (ex: "R$ 1.234,56" ou "-R$ 123,45")
 * @returns {{amount: number, direction: string}} Valor em centavos e direção
 */
function parseAmount(amountStr) {
  if (!amountStr) {
    return { amount: 0, direction: 'in' };
  }

  // Remove símbolo de moeda e espaços
  const cleaned = String(amountStr)
    .replace(/R\$\s?/gi, '')
    .replace(/\s/g, '')
    .trim();

  // Detecta sinal negativo
  const isNegative = cleaned.startsWith('-') || cleaned.startsWith('(');

  // Remove caracteres não numéricos, exceto vírgula e ponto
  let numStr = cleaned
    .replace(/[^\d,.]/g, '')
    .replace(/\./g, '') // Remove separador de milhar (ponto)
    .replace(',', '.'); // Troca vírgula decimal por ponto

  const numValue = parseFloat(numStr);

  if (isNaN(numValue)) {
    logger.warn(`Valor inválido: "${amountStr}" -> "${numStr}"`);
    return { amount: 0, direction: 'in' };
  }

  const amountCents = Math.abs(Math.round(numValue * 100));
  const direction = (isNegative || numValue < 0) ? 'out' : 'in';

  return { amount: amountCents, direction };
}

/**
 * Valida se o buffer parece ser um CSV do Nubank
 * @param {Buffer} buffer
 * @returns {boolean}
 */
function validateNubankCsv(buffer) {
  try {
    const text = buffer.toString('utf-8');
    const firstLine = text.split('\n')[0].toLowerCase();

    // Procura por palavras-chave típicas do header Nubank
    const keywords = ['data', 'valor', 'descrição', 'categoria', 'description', 'amount'];
    const hasKeywords = keywords.some(keyword => firstLine.includes(keyword));

    if (!hasKeywords) {
      logger.warn('CSV não parece ser do Nubank (header não reconhecido)');
      return false;
    }

    return true;

  } catch (err) {
    logger.error('Erro ao validar CSV:', err.message);
    return false;
  }
}

module.exports = { 
  parseNubankCsvBuffer, 
  parseCSVLine, 
  parseNubankRow,
  validateNubankCsv,
  parseDate,
  parseAmount
};
