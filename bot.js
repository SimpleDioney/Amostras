/**
 * BOT GERENCIADOR DE AMOSTRAS - WPPCONNECT
 * VERSÃO SQLITE FINAL - Migração completa da versão estável com JSON
 */

// --- Importações ---
const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const exceljs = require('exceljs');
const sqlite3 = require('sqlite3').verbose();

// --- Constantes e Variáveis Globais ---
const DB_PATH = './database.sqlite';
const tempDevolutivas = {}; // Armazenamento temporário para a função de correção

// =================================================================================================
// SEÇÃO DE MANIPULAÇÃO DO BANCO DE DADOS (SQLITE)
// =================================================================================================

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Erro ao conectar ao SQLite:', err.message);
    process.exit(1);
  }
  console.log('✅ Conectado ao banco de dados SQLite.');
});

function dbAll(query, params = []) {
  return new Promise((resolve, reject) => {
    db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function dbGet(query, params = []) {
  return new Promise((resolve, reject) => {
    db.get(query, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(query, params = []) {
  return new Promise((resolve, reject) => {
    db.run(query, params, function (err) { (err ? reject(err) : resolve(this)) });
  });
}

async function initializeDb() {
  await dbRun(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
  await dbRun(`CREATE TABLE IF NOT EXISTS users (wppId TEXT PRIMARY KEY, name TEXT, type TEXT)`);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS samples (
      sampleId TEXT PRIMARY KEY,
      ownerId TEXT,
      status TEXT,
      receivedDate TEXT,
      customerName TEXT,
      contractClosed INTEGER,
      followUpDate TEXT,
      followUpNotified INTEGER DEFAULT 0,
      clientFeedback TEXT,
      FOREIGN KEY(ownerId) REFERENCES users(wppId) ON DELETE CASCADE
    )
  `);
  await dbRun(`
    CREATE TABLE IF NOT EXISTS user_state (
      wppId TEXT PRIMARY KEY,
      stateJson TEXT,
      FOREIGN KEY(wppId) REFERENCES users(wppId) ON DELETE CASCADE
    )
  `);

  const configCount = await dbGet('SELECT COUNT(*) as count FROM config');
  if (configCount.count === 0) {
    console.log('⚙️ Populando configuração inicial no banco de dados...');
    await dbRun(`INSERT OR IGNORE INTO config (key, value) VALUES (?, ?), (?, ?), (?, ?), (?, ?), (?, ?)`, [
      'adminContact', '554391964950@c.us',
      'sampleOverdueDays', '7',
      'devolutivaCorrectionSeconds', '300',
      'progressiveReminderDaysTier1', '8',
      'progressiveReminderDaysTier2', '14'
    ]);
  }
}

let configCache = null;
async function getConfig() {
  if (configCache) return configCache;
  const rows = await dbAll('SELECT key, value FROM config');
  configCache = rows.reduce((acc, row) => {
    acc[row.key] = /^\d+$/.test(row.value) ? parseInt(row.value, 10) : row.value;
    return acc;
  }, {});
  return configCache;
}

async function getAdminContact() {
    const config = await getConfig();
    return config.adminContact;
}

async function getUser(wppId) {
  const user = await dbGet('SELECT * FROM users WHERE wppId = ?', [wppId]);
  if (!user) return null;
  user.samples = await dbAll('SELECT * FROM samples WHERE ownerId = ?', [wppId]);
  return user;
}

async function getUsersByType(type) {
  const users = await dbAll('SELECT * FROM users WHERE type = ?', [type]);
  for (const user of users) {
    user.samples = await dbAll('SELECT * FROM samples WHERE ownerId = ?', [user.wppId]);
  }
  return users;
}

async function getUserState(wppId) {
  const row = await dbGet('SELECT stateJson FROM user_state WHERE wppId = ?', [wppId]);
  return row ? JSON.parse(row.stateJson) : null;
}

async function setUserState(wppId, state) {
  const stateJson = JSON.stringify(state);
  await dbRun('INSERT OR REPLACE INTO user_state (wppId, stateJson) VALUES (?, ?)', [wppId, stateJson]);
}

async function clearUserState(wppId) {
  await dbRun('DELETE FROM user_state WHERE wppId = ?', [wppId]);
}

// =================================================================================================
// LÓGICA PRINCIPAL DO BOT
// =================================================================================================

wppconnect
  .create({
    session: 'gerenciador-amostras',
    catchQR: (base64Qr, asciiQR) => {
      console.log(asciiQR);
      console.log('Leia o QR Code com o seu celular para iniciar.');
    },
    statusFind: (statusSession, session) => {
      console.log('Status da Sessão:', statusSession, '| Nome da Sessão:', session);
    },
    autoClose: false,
    deviceSyncTimeout: 0,
    headless: true,
  })
  .then(async (client) => {
    await initializeDb();
    start(client);
  })
  .catch((error) => console.log('❌ Erro ao criar o cliente:', error));


function start(client) {
  console.log('🚀 Bot iniciado com sucesso! Usando banco de dados SQLite.');

  client.onMessage(async (message) => {
    if (message.isGroupMsg || !message.from || message.fromMe) return;

    const user = await getUser(message.from);
    if (!user) {
      console.log(`👤 Mensagem ignorada de número não cadastrado: ${message.from}`);
      return;
    }

    const userState = await getUserState(message.from);

    if (userState && userState.awaiting) {
      await handleStatefulResponse(client, message, user, userState);
    } else if (user.type === 'camarista') {
      await handleCamaristaFlow(client, message, user);
    } else if (user.type === 'vendedor') {
      await handleVendedorFlow(client, message, user);
    } else if (user.type === 'admin') {
      await handleAdminFlow(client, message, user);
    }
  });

  cron.schedule('0 9 * * *', async () => {
    console.log(`⏰ CRON 9h: Verificando amostras atrasadas e follow-ups...`);
    const config = await getConfig();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const overdueLimitDate = new Date();
    overdueLimitDate.setDate(today.getDate() - config.sampleOverdueDays);
    await dbRun(`UPDATE samples SET status = 'overdue' WHERE status = 'pending_feedback' AND receivedDate < ?`, [overdueLimitDate.toISOString()]);
    
    const vendedores = await getUsersByType('vendedor');
    const adminContact = await getAdminContact();

    for (const user of vendedores) {
      for (const sample of user.samples) {
        if (sample.status === 'overdue') {
            const receivedDate = new Date(sample.receivedDate);
            const daysPassed = Math.floor((today - receivedDate) / (1000 * 60 * 60 * 24));
            let reminderMessage = '';
            if (daysPassed >= config.progressiveReminderDaysTier2) {
                reminderMessage = `🚨 *ATENÇÃO MÁXIMA - DEVOLUÇÃO ATRASADA* 🚨\n\nA amostra de ID final *...${sample.sampleId.slice(-6)}* está com a devolução pendente há *${daysPassed} dias*.\n\nEsta é uma notificação final. Seu gestor foi informado. Por favor, regularize a situação *imediatamente*.`;
                if (adminContact) await client.sendText(adminContact, `*[ALERTA GESTOR]*\nO vendedor *${user.name}* está com a amostra (...${sample.sampleId.slice(-6)}) atrasada há ${daysPassed} dias.`).catch(e => console.error("Falha ao notificar admin"));
            } else if (daysPassed >= config.progressiveReminderDaysTier1) {
                reminderMessage = `⚠️ *DEVOLUÇÃO MUITO ATRASADA* ⚠️\n\nA amostra de ID final *...${sample.sampleId.slice(-6)}* está com a devolução pendente há *${daysPassed} dias*.\n\nO prazo de devolução expirou. Por favor, procure um camarista para regularizar a situação com urgência.`;
            } else {
                reminderMessage = `❗️ *DEVOLUÇÃO ATRASADA* ❗️\n\nA amostra de ID final *...${sample.sampleId.slice(-6)}*, retirada em ${receivedDate.toLocaleDateString('pt-BR')}, está com a devolução pendente.\n\nPor favor, procure um camarista para realizar a devolução.`;
            }
            await client.sendText(user.wppId, reminderMessage).catch(e => console.error(`Falha ao enviar lembrete de atraso para ${user.wppId}: ${e.message}`));
        }
        if (sample.status === 'awaiting_client_response' && sample.followUpDate && !sample.followUpNotified) {
            const followUpDate = new Date(sample.followUpDate);
            if (followUpDate <= today) {
                const messageText = `Lembrete: Você tem um follow-up agendado para hoje com o cliente *${sample.customerName}*.\n\nPor favor, inicie a devolução selecionando a opção "Dar Devolutiva de Follow-up" no seu menu.`;
                await client.sendText(user.wppId, messageText).catch(e => console.error(`Falha ao enviar lembrete de follow-up para ${user.wppId}: ${e.message}`));
                await dbRun('UPDATE samples SET followUpNotified = 1 WHERE sampleId = ?', [sample.sampleId]);
            }
        }
      }
    }
  }, {
    timezone: "America/Sao_Paulo"
  });
}

// =================================================================================================
// FLUXOS PRINCIPAIS (TODOS ASYNC)
// =================================================================================================

async function handleCamaristaFlow(client, message, user) {
  const from = message.from;
  let action = message.listResponse?.singleSelectReply?.selectedRowId || message.selectedId || message.body.toLowerCase();
  
  if (!message.listResponse?.singleSelectReply?.selectedRowId && !message.selectedId) {
    if (action.includes('adicionar')) action = 'addVendedor';
    else if (action.includes('remover')) action = 'removeVendedor';
    else if (action.includes('entregar')) action = 'deliverSamples';
    else if (action.includes('limpar')) action = 'clearSamples';
  }

  switch (action) {
    case 'addVendedor':
      await setUserState(from, { awaiting: 'add_vendedor_info' });
      await client.sendText(from, 'OK. Envie o nome e o número do novo vendedor no formato:\n\n*Nome do Vendedor, 5543988887777*');
      break;
    case 'removeVendedor':
      const vendedoresToRemove = await getUsersByType('vendedor');
      if (vendedoresToRemove.length === 0) {
        await client.sendText(from, 'Não há vendedores para remover.');
        return sendCamaristaMenu(client, from, user);
      }
      const rowsToRemove = vendedoresToRemove.map(v => ({ rowId: `remove_${v.wppId}`, title: v.name, description: v.wppId.split('@')[0] }));
      await client.sendListMessage(from, { buttonText: 'Selecionar Vendedor', description: 'Quem você deseja remover?', sections: [{ title: 'Lista de Vendedores', rows: rowsToRemove }] });
      await setUserState(from, { awaiting: 'select_vendor_for_removal' });
      break;
    case 'deliverSamples':
      const vendedoresToDeliver = (await getUsersByType('vendedor')).filter(v => !v.samples.some(s => s.status === 'pending_feedback' || s.status === 'overdue'));
      if (vendedoresToDeliver.length === 0) {
        await client.sendText(from, 'Não há vendedores disponíveis para receber amostras (todos possuem pendências ou não há vendedores cadastrados).');
        return sendCamaristaMenu(client, from, user);
      }
      const rowsToDeliver = vendedoresToDeliver.map(v => ({ rowId: `deliver_${v.wppId}`, title: v.name, description: `${v.samples.length} amostras no total` }));
      await client.sendListMessage(from, { buttonText: 'Selecionar Vendedor', description: 'Para quem você vai entregar amostras?', sections: [{ title: 'Vendedores sem Pendências', rows: rowsToDeliver }] });
      await setUserState(from, { awaiting: 'select_vendor_for_delivery' });
      break;
    case 'clearSamples':
      const allVendors = await getUsersByType('vendedor');
      if (allVendors.length === 0) {
        await client.sendText(from, 'Não há vendedores cadastrados.');
        return sendCamaristaMenu(client, from, user);
      }
      const rowsToClear = allVendors.map(v => {
        const pendingCount = v.samples.filter(s => s.status === 'pending_feedback' || s.status === 'overdue').length;
        return { rowId: `clear_${v.wppId}`, title: v.name, description: `${pendingCount} amostra(s) pendente(s)/atrasada(s)` };
      });
      await client.sendListMessage(from, { buttonText: 'Selecionar Vendedor', description: 'De qual vendedor você deseja limpar as amostras devolvidas?', sections: [{ title: 'Lista de Todos os Vendedores', rows: rowsToClear }] });
      await setUserState(from, { awaiting: 'select_vendor_for_clearance' });
      break;
    default:
      await sendCamaristaMenu(client, from, user);
      break;
  }
}

async function handleVendedorFlow(client, message, user) {
    const from = message.from;
    const action = message.listResponse?.singleSelectReply?.selectedRowId || message.selectedId || message.body.toLowerCase();

    if (action === 'correct_last_devolutive') {
        const storedDevolutiva = tempDevolutivas[from];
        if (storedDevolutiva) {
            clearTimeout(storedDevolutiva.timeoutId);
            const { originalSample, originalState } = storedDevolutiva;
            await dbRun(`UPDATE samples SET status=?, customerName=?, contractClosed=?, followUpDate=?, clientFeedback=?, followUpNotified=? WHERE sampleId=?`,
                [originalSample.status, originalSample.customerName, originalSample.contractClosed, originalSample.followUpDate, originalSample.clientFeedback, originalSample.followUpNotified, originalSample.sampleId]);
            
            delete tempDevolutivas[from];
            await client.sendText(from, '✅ Devolutiva anterior cancelada. Retornando ao passo anterior...');
            await setUserState(from, originalState);
            return reaskPreviousQuestion(client, from, originalState);
        } else {
            await client.sendText(from, 'O tempo para correção expirou ou não há devolução para corrigir.');
            return sendVendedorMenu(client, from, user);
        }
    }
    else if (action === 'consultar_amostras') {
        let responseText = `Olá, *${user.name}*! Aqui está o resumo das suas amostras:\n`;
        const pendingSamples = user.samples?.filter(s => s.status === 'pending_feedback') || [];
        const overdueSamples = user.samples?.filter(s => s.status === 'overdue') || [];
        const followupSamples = user.samples?.filter(s => s.status === 'awaiting_client_response') || [];

        if (pendingSamples.length === 0 && overdueSamples.length === 0 && followupSamples.length === 0) {
            responseText = 'Você não possui nenhuma amostra pendente no momento. ✅';
        } else {
            if (overdueSamples.length > 0) {
                responseText += `\n*🚨 ATRASADAS (${overdueSamples.length})*\n`;
                overdueSamples.forEach(s => { responseText += ` • ID ...${s.sampleId.slice(-6)} (Recebida em ${new Date(s.receivedDate).toLocaleDateString('pt-BR')})\n`; });
            }
            if (pendingSamples.length > 0) {
                responseText += `\n*⏳ PENDENTES DE FEEDBACK (${pendingSamples.length})*\n`;
                pendingSamples.forEach(s => { responseText += ` • ID ...${s.sampleId.slice(-6)} (Recebida em ${new Date(s.receivedDate).toLocaleDateString('pt-BR')})\n`; });
            }
            if (followupSamples.length > 0) {
                responseText += `\n*🗓️ AGUARDANDO CLIENTE (${followupSamples.length})*\n`;
                followupSamples.forEach(s => { responseText += ` • ID ...${s.sampleId.slice(-6)} (Cliente: ${s.customerName})\n`; });
            }
        }
        await client.sendText(from, responseText);
        return sendVendedorMenu(client, from, user);
    }
    else if (action === 'start_devolutiva_nova') {
        const pendingSamples = user.samples.filter(s => s.status === 'pending_feedback' || s.status === 'overdue');
        if (pendingSamples.length === 0) {
            return client.sendText(from, 'Você não possui amostras com devolução pendente no momento.');
        }
        const sampleRows = pendingSamples.map(s => ({ rowId: s.sampleId, title: `Amostra ...${s.sampleId.slice(-6)}`, description: `Recebida em ${new Date(s.receivedDate).toLocaleDateString('pt-BR')}` }));
        await client.sendListMessage(from, { buttonText: 'Selecionar Amostra', description: 'Qual amostra você está dando o feedback?', sections: [{ title: 'Suas Amostras Pendentes', rows: sampleRows }] });
        await setUserState(from, { awaiting: 'select_sample_for_devolution' });
    }
    else if (action === 'start_devolutiva_followup') {
        const followupSamples = user.samples.filter(s => s.status === 'awaiting_client_response');
        if (followupSamples.length === 0) {
            return client.sendText(from, 'Você não possui nenhum follow-up agendado no momento.');
        }
        const sampleRows = followupSamples.map(s => ({ rowId: s.sampleId, title: `Amostra ...${s.sampleId.slice(-6)}`, description: `Cliente: ${s.customerName} | Agendado para: ${new Date(s.followUpDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}` }));
        await client.sendListMessage(from, { buttonText: 'Selecionar Follow-up', description: 'De qual follow-up você dará a devolução?', sections: [{ title: 'Seus Follow-ups Agendados', rows: sampleRows }] });
        await setUserState(from, { awaiting: 'select_sample_for_followup' });
    }
    else {
        await sendVendedorMenu(client, from, user);
    }
}

async function handleAdminFlow(client, message, user) {
  const from = message.from;
  const action = message.listResponse?.singleSelectReply?.selectedRowId || message.selectedId;

  if (!action) return sendAdminMenu(client, from, user);

  let reportPath = null;
  try {
    switch (action) {
      case 'report_all_samples':
        await client.sendText(from, '⚙️ Gerando o relatório completo de amostras...');
        reportPath = await generateGeneralReportExcel();
        await client.sendFile(from, reportPath, `Relatorio_Geral_Amostras.xlsx`, '📄 Aqui está o relatório completo.');
        break;
      case 'report_by_vendor':
        const vendors = await getUsersByType('vendedor');
        if (vendors.length === 0) return client.sendText(from, 'Não há vendedores cadastrados para gerar um relatório.');
        const vendorRows = vendors.map(v => ({ rowId: `select_vendor_${v.wppId}`, title: v.name }));
        await client.sendListMessage(from, { buttonText: 'Selecionar', description: 'Selecione o vendedor para gerar o relatório:', sections: [{ title: 'Vendedores', rows: vendorRows }] });
        await setUserState(from, { awaiting: 'admin_select_vendor_for_report' });
        return;
      case 'report_overdue':
        await client.sendText(from, '⚙️ Gerando o relatório de amostras atrasadas...');
        reportPath = await generateGeneralReportExcel({ status: 'overdue' });
        await client.sendFile(from, reportPath, `Relatorio_Amostras_Atrasadas.xlsx`, '📄 Aqui está o relatório de amostras atrasadas.');
        break;
      case 'add_user':
        await setUserState(from, { awaiting: 'admin_add_user_info' });
        await client.sendText(from, 'Qual o nome e o número do novo usuário?\n\nEnvie no formato: *Nome Completo, 55439...*');
        break;
      
      case 'remove_user':
        const allUsers = await dbAll('SELECT * FROM users WHERE wppId != ?', [from]); // Pega todos, menos o próprio admin
        if(allUsers.length === 0) {
            return client.sendText(from, 'Não há outros usuários para remover.');
        }
        const userRows = allUsers.map(u => ({
            rowId: `admin_remove_${u.wppId}`,
            title: u.name,
            description: `Tipo: ${u.type} | Número: ${u.wppId.split('@')[0]}`
        }));
        await client.sendListMessage(from, {
            buttonText: 'Selecionar',
            description: 'Selecione o usuário que deseja remover:',
            sections: [{ title: 'Usuários Cadastrados', rows: userRows }]
        });
        await setUserState(from, { awaiting: 'admin_select_user_for_removal' });
        break;

      default:
        await sendAdminMenu(client, from, user);
        break;
    
    }
  } catch (error) {
    console.error("❌ Erro ao gerar ou enviar relatório:", error);
    await client.sendText(from, '❌ Ocorreu um erro ao processar sua solicitação.');
  } finally {
    if (reportPath && fs.existsSync(reportPath)) {
      fs.unlinkSync(reportPath);
    }
  }
}

// =================================================================================================
// MENUS E FUNÇÕES AUXILIARES
// =================================================================================================

async function sendCamaristaMenu(client, to, user) {
  await client.sendListMessage(to, { buttonText: 'Opções', description: `Menu Principal do Camarista`, sections: [{ title: 'Ações Disponíveis', rows: [{ rowId: 'deliverSamples', title: '🚚 Entregar Amostras' }, { rowId: 'addVendedor', title: '➕ Adicionar Vendedor' }, { rowId: 'removeVendedor', title: '➖ Remover Vendedor' }, { rowId: 'clearSamples', title: '🧹 Limpar Amostras (Granular)' }] }] });
}
async function sendVendedorMenu(client, to, user) {
  await client.sendListMessage(to, { buttonText: 'Opções', description: `Olá, *${user.name}*! Selecione uma ação.`, sections: [{ title: 'Ações de Amostra', rows: [{ rowId: 'start_devolutiva_nova', title: '✅ Dar Devolutiva de Amostra' }, { rowId: 'start_devolutiva_followup', title: '🗣️ Dar Devolutiva de Follow-up' }, { rowId: 'consultar_amostras', title: '📋 Consultar Minhas Amostras' }] }] });
}
async function sendAdminMenu(client, to, user) {
  await client.sendListMessage(to, {
    buttonText: 'Opções de Admin',
    description: `Olá, *${user.name}*! Selecione uma ação.`,
    sections: [
      {
        title: 'Relatórios',
        rows: [
          { rowId: 'report_all_samples', title: '📊 Relatório Geral de Amostras' },
          { rowId: 'report_by_vendor', title: '👨‍💼 Relatório por Vendedor' },
          { rowId: 'report_overdue', title: '⏰ Relatório de Amostras Atrasadas' }
        ],
      },
      {
        title: 'Gerenciamento',
        rows: [
            { rowId: 'add_user', title: '➕ Adicionar Usuário' },
            { rowId: 'remove_user', title: '➖ Remover Usuário' }
        ]
      }
    ],
  });
}

async function generateGeneralReportExcel(filters = {}) {
    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('Relatório de Amostras');
    const statusMap = { pending_feedback: 'Pendente Feedback', overdue: 'Atrasada', awaiting_client_response: 'Aguardando Cliente', closed_deal: 'Contrato Fechado', feedback_received: 'Feedback Recebido (Sem Venda)' };
    worksheet.columns = [{ header: 'Vendedor', key: 'vendedor', width: 25 }, { header: 'Status', key: 'status', width: 25 }, { header: 'Cliente', key: 'cliente', width: 25 }, { header: 'Contrato Fechado', key: 'contrato', width: 20 }, { header: 'Data de Recebimento', key: 'recebimento', width: 20 }, { header: 'Data do Follow-up', key: 'followup', width: 20 }, { header: 'ID da Amostra', key: 'id', width: 40 }, { header: 'Feedback do Cliente', key: 'feedback', width: 50 }];
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F81BD' } };

    let query = `SELECT u.name, s.* FROM samples s JOIN users u ON s.ownerId = u.wppId WHERE 1=1`;
    const params = [];
    if(filters.status) {
        query += ` AND s.status = ?`;
        params.push(filters.status);
    }
    if(filters.vendorId){
        query += ` AND s.ownerId = ?`;
        params.push(filters.vendorId);
    }
    const rows = await dbAll(query, params);

    for (const row of rows) {
        worksheet.addRow({
            vendedor: row.name,
            status: statusMap[row.status] || row.status,
            cliente: row.customerName || '-',
            contrato: typeof row.contractClosed === 'number' ? (row.contractClosed === 1 ? 'Sim' : 'Não') : '-',
            recebimento: new Date(row.receivedDate).toLocaleDateString('pt-BR'),
            followup: row.followUpDate ? new Date(row.followUpDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '-',
            id: row.sampleId,
            feedback: row.clientFeedback || '-',
        });
    }

    const filePath = `./relatorio_temp_${uuidv4()}.xlsx`;
    await workbook.xlsx.writeFile(filePath);
    return filePath;
}

async function finalizeDevolution(client, from, state, updates) {
    const originalSample = await dbGet('SELECT * FROM samples WHERE sampleId = ?', [state.currentSampleId]);
    if (!originalSample) return;
    const originalState = JSON.parse(JSON.stringify(state));

    const finalData = { ...originalSample, ...state, ...updates, awaiting: undefined };
    await dbRun(
        `UPDATE samples SET status=?, customerName=?, contractClosed=?, followUpDate=?, clientFeedback=?, followUpNotified=? WHERE sampleId=?`,
        [finalData.status, finalData.customerName, finalData.contractClosed, finalData.followUpDate, finalData.clientFeedback, finalData.followUpNotified, finalData.sampleId]
    );

    const config = await getConfig();
    const timeoutId = setTimeout(async () => {
        const vendedor = await getUser(from);
        const finalSampleData = await dbGet('SELECT * FROM samples WHERE sampleId = ?', [state.currentSampleId]);
        await sendFinalReport(client, vendedor, finalSampleData);
        delete tempDevolutivas[from];
    }, config.devolutivaCorrectionSeconds * 1000);

    tempDevolutivas[from] = { originalSample, originalState, timeoutId };

    let successMessage = '✅ Devolutiva registrada com sucesso! Obrigado!';
    if (updates.status === 'awaiting_client_response') {
        successMessage = `✅ Ok, agendado para ${new Date(updates.followUpDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}! Te lembrarei na data. Obrigado!`;
    } else if (updates.status === 'closed_deal') {
        successMessage = '✅ Contrato fechado! Devolutiva registrada com sucesso!';
    }

    await client.sendListMessage(from, { buttonText: 'Opções', description: successMessage, sections: [{ title: `Aguardando ${config.devolutivaCorrectionSeconds / 60} min para envio final`, rows: [{ rowId: 'correct_last_devolutive', title: 'Corrigir Devolutiva' }] }] });
    await clearUserState(from);
}

async function reaskPreviousQuestion(client, from, state) {
    switch (state.awaiting) {
        case 'contract_closed':
            return client.sendListMessage(from, { buttonText: 'Selecione', description: 'Você fechou contrato com este cliente?', sections: [{ title: 'Opções', rows: [{ rowId: 'contract_yes', title: 'Sim' }, { rowId: 'contract_no', title: 'Não' }] }] });
        case 'initial_feedback_or_followup':
            return client.sendListMessage(from, { buttonText: 'Selecione', description: 'Qual o próximo passo com o cliente?', sections: [{ title: 'Opções', rows: [{ rowId: 'get_final_feedback', title: 'Já tenho o feedback final' }, { rowId: 'schedule_followup', title: 'Preciso agendar um follow-up' }] }] });
        case 'follow_up_date_selection':
            return client.sendListMessage(from, { buttonText: 'Escolher Data', description: 'Quando você fará o follow-up?', sections: [{ title: 'Opções de Data', rows: [{ rowId: 'date_tomorrow', title: 'Amanhã' }, { rowId: 'date_2_days', title: 'Em 2 dias' }, { rowId: 'date_7_days', title: 'Em 7 dias' }, { rowId: 'date_15_days', title: 'Em 15 dias' }, { rowId: 'date_manual', title: 'Digitar data específica' }] }] });
        case 'client_feedback':
            return client.sendText(from, 'Ok. Qual foi a devolução/feedback final do cliente?');
        default:
            const user = await getUser(from);
            return sendVendedorMenu(client, from, user);
    }
}

async function sendFinalReport(client, vendedor, sampleData) {
    const adminContact = await getAdminContact();
    if (!adminContact) return console.error("Contato do admin não configurado.");
    if (!sampleData || !vendedor) return console.error(`Relatório não pôde ser gerado.`);
    
    try {
        const statusMap = { closed_deal: '✅ Contrato Fechado', awaiting_client_response: '🗓️ Aguardando Resposta do Cliente', feedback_received: '🗣️ Feedback Recebido (Sem Venda)' };
        const friendlyStatus = statusMap[sampleData.status] || sampleData.status;
        let report = `🔔 *Relatório de Devolutiva de Amostra* 🔔\n\n`;
        report += `*Vendedor:* ${vendedor.name}\n`;
        report += `*Amostra ID:* ...${sampleData.sampleId.slice(-6)}\n`;
        report += `*Cliente:* ${sampleData.customerName || 'Não informado'}\n`;
        report += `*Contrato Fechado:* ${typeof sampleData.contractClosed === 'number' ? (sampleData.contractClosed === 1 ? '✅ Sim' : '❌ Não') : 'Não se aplica'}\n`;
        if (sampleData.clientFeedback) report += `*Feedback do Cliente:* ${sampleData.clientFeedback}\n`;
        if (sampleData.followUpDate) report += `*Data para Follow-up:* ${new Date(sampleData.followUpDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}\n`;
        report += `\n*Status Final:* ${friendlyStatus}`;
        await client.sendText(adminContact, report);
        console.log(`📄 Relatório para a amostra ...${sampleData.sampleId.slice(-6)} enviado ao admin.`);
    } catch (e) {
        console.error(`Erro inesperado ao enviar relatório para o Admin ${adminContact}:`, e.message);
    }
}

// =================================================================================================
// MANIPULADOR DE ESTADOS (handleStatefulResponse)
// =================================================================================================

async function handleStatefulResponse(client, message, user, state) {
  const from = message.from;
  const bodyLower = message.body.toLowerCase();
  const listClickId = message.listResponse?.singleSelectReply?.selectedRowId;
  const action = listClickId || bodyLower;

  if (bodyLower === 'cancelar' || bodyLower === 'sair') {
    await clearUserState(from);
    await client.sendText(from, '✅ Operação cancelada.');
    if (user.type === 'camarista') return sendCamaristaMenu(client, from, user);
    if (user.type === 'vendedor') return sendVendedorMenu(client, from, user);
    if (user.type === 'admin') return sendAdminMenu(client, from, user);
    return;
  }

  switch (state.awaiting) {
    case 'add_vendedor_info': {
        const [name, number] = message.body.split(',').map(s => s.trim());
        if (!name || !number || !/^\d+$/.test(number)) return client.sendText(from, 'Formato inválido. Envie: `Nome, 55439...`');
        const wppId = `${number}@c.us`;
        try {
            if (!(await client.checkNumberStatus(wppId)).numberExists) return client.sendText(from, `⚠️ O número *${number}* parece não ser um WhatsApp válido.`);
        } catch (e) { return client.sendText(from, "⚠️ Não consegui validar o número. Tente novamente."); }
        const existingUser = await dbGet('SELECT * FROM users WHERE wppId = ?', [wppId]);
        if (existingUser) await client.sendText(from, 'Este número já está cadastrado.');
        else {
            await dbRun('INSERT INTO users (wppId, name, type) VALUES (?, ?, ?)', [wppId, name, 'vendedor']);
            await client.sendText(from, `✅ Vendedor *${name}* adicionado com sucesso!`);
        }
        await clearUserState(from);
        return sendCamaristaMenu(client, from, user);
    }
    case 'select_vendor_for_removal': {
        const targetId = listClickId.split('remove_')[1];
        const removedUser = await dbGet('SELECT name FROM users WHERE wppId = ?', [targetId]);
        await dbRun('DELETE FROM users WHERE wppId = ?', [targetId]);
        await client.sendText(from, `🗑️ Vendedor *${removedUser?.name || 'desconhecido'}* removido.`);
        await clearUserState(from);
        return sendCamaristaMenu(client, from, user);
    }
    case 'select_vendor_for_delivery': {
        const targetId = listClickId.split('deliver_')[1];
        const vendedor = await getUser(targetId);
        await setUserState(from, { awaiting: 'deliver_samples_quantity', selectedVendedorId: targetId });
        return client.sendText(from, `Quantas amostras você entregou para *${vendedor.name}*?`);
    }
    case 'deliver_samples_quantity': {
        const quantity = parseInt(message.body);
        if (isNaN(quantity) || quantity <= 0) return client.sendText(from, 'Por favor, envie um número válido.');
        const vendedorId = state.selectedVendedorId;
        const vendedor = await getUser(vendedorId);
        const config = await getConfig();
        for (let i = 0; i < quantity; i++) {
            await dbRun('INSERT INTO samples (sampleId, ownerId, receivedDate, status) VALUES (?, ?, ?, ?)', [uuidv4(), vendedorId, new Date().toISOString(), 'pending_feedback']);
        }
        await client.sendText(from, `✅ *${quantity}* amostra(s) registrada(s) para *${vendedor.name}*.`);
        await clearUserState(from);
        await sendCamaristaMenu(client, from, user);
        try {
            await client.sendListMessage(vendedorId, { buttonText: 'Ações', description: `Olá, *${vendedor.name}*! Você recebeu *${quantity}* nova(s) amostra(s) hoje.\n\n*Atenção:* Você tem até *${config.sampleOverdueDays} dias* para dar o feedback!`, sections: [{ title: 'Opções', rows: [{ rowId: 'start_devolutiva_nova', title: 'Dar Devolutiva de Amostra' }] }] });
        } catch (e) { await client.sendText(from, `⚠️ Não foi possível notificar *${vendedor.name}*.`); }
        return;
    }
    case 'select_vendor_for_clearance': {
        const targetId = listClickId.split('clear_')[1];
        const vendedor = await getUser(targetId);
        const samplesToClear = vendedor.samples.filter(s => s.status === 'pending_feedback' || s.status === 'overdue');
        if (samplesToClear.length === 0) {
            await client.sendText(from, `O vendedor *${vendedor.name}* não possui amostras pendentes.`);
            await clearUserState(from);
            return sendCamaristaMenu(client, from, user);
        }
        let responseText = `Selecione as amostras de *${vendedor.name}* que foram devolvidas:\n\n`;
        const selectableSamples = samplesToClear.map((s, i) => { responseText += `*${i + 1}* - ID ...${s.sampleId.slice(-6)} (${s.status})\n`; return { sampleId: s.sampleId }; });
        responseText += '\nResponda com os *números* das amostras que deseja limpar, separados por vírgula (ex: 1, 3).';
        await setUserState(from, { awaiting: 'confirm_granular_clearance', vendorToClearId: targetId, selectableSamples });
        return client.sendText(from, responseText);
    }
    case 'confirm_granular_clearance': {
        const selections = message.body.split(',').map(n => parseInt(n.trim()));
        const { vendorToClearId, selectableSamples } = state;
        const vendedor = await getUser(vendorToClearId);
        let clearedCount = 0;
        for (const selection of selections) {
            if (!isNaN(selection) && selection > 0 && selection <= selectableSamples.length) {
                const sampleIdToClear = selectableSamples[selection - 1].sampleId;
                const result = await dbRun('DELETE FROM samples WHERE sampleId = ?', [sampleIdToClear]);
                if (result.changes > 0) clearedCount++;
            }
        }
        await client.sendText(from, clearedCount > 0 ? `✅ *${clearedCount}* amostra(s) de *${vendedor.name}* foram limpas.` : `Nenhuma amostra válida foi selecionada.`);
        await clearUserState(from);
        return sendCamaristaMenu(client, from, user);
    }
    case 'admin_select_vendor_for_report': {
        const vendorId = listClickId.split('select_vendor_')[1];
        const vendor = await getUser(vendorId);
        await client.sendText(from, `⚙️ Gerando o relatório para *${vendor.name}*...`);
        const reportPath = await generateGeneralReportExcel({ vendorId: vendorId });
        await client.sendFile(from, reportPath, `Relatorio_${vendor.name.replace(/ /g, '_')}.xlsx`, `📄 Aqui está o relatório para *${vendor.name}*.`);
        if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
        await clearUserState(from);
        return sendAdminMenu(client, from, user);
    }
    case 'select_sample_for_devolution': {
        if (!listClickId) return;
        await setUserState(from, { awaiting: 'customer_name', currentSampleId: listClickId });
        return client.sendText(from, `Ótimo! Sobre a amostra *...${listClickId.slice(-6)}*:\n\nPara qual cliente foi?`);
    }
    case 'select_sample_for_followup': {
        if (!listClickId) return;
        const foundSample = await dbGet('SELECT * FROM samples WHERE sampleId = ?', [listClickId]);
        await setUserState(from, { awaiting: 'client_returned', currentSampleId: foundSample.sampleId, customerName: foundSample.customerName });
        return client.sendListMessage(from, { buttonText: 'Selecione', description: `Devolutiva do follow-up com *${foundSample.customerName}*.\nO cliente já deu o feedback final?`, sections: [{ title: 'Opções', rows: [{ rowId: 'feedback_yes', title: 'Sim (deu feedback)' }, { rowId: 'feedback_no', title: 'Não (reagendar visita)' }] }] });
    }
    case 'customer_name': {
        await setUserState(from, { ...state, awaiting: 'contract_closed', customerName: message.body });
        return client.sendListMessage(from, { buttonText: 'Selecione', description: 'Entendido. E você fechou contrato com este cliente?', sections: [{ title: 'Opções', rows: [{ rowId: 'contract_yes', title: 'Sim' }, { rowId: 'contract_no', title: 'Não' }] }] });
    }
    case 'contract_closed': {
        if (action === 'contract_yes') return finalizeDevolution(client, from, state, { contractClosed: 1, status: 'closed_deal' });
        if (action === 'contract_no') {
            await setUserState(from, { ...state, awaiting: 'initial_feedback_or_followup', contractClosed: 0 });
            return client.sendListMessage(from, { buttonText: 'Selecione', description: 'Entendido. E qual o próximo passo?', sections: [{ title: 'Opções', rows: [{ rowId: 'get_final_feedback', title: 'Já tenho o feedback final' }, { rowId: 'schedule_followup', title: 'Preciso agendar um follow-up' }] }] });
        }
        break;
    }
    case 'initial_feedback_or_followup': {
        if (action === 'get_final_feedback') {
            await setUserState(from, { ...state, awaiting: 'client_feedback' });
            return client.sendText(from, 'Ok. Qual foi a devolução/feedback final do cliente?');
        }
        if (action === 'schedule_followup') {
            await setUserState(from, { ...state, awaiting: 'follow_up_date_selection' });
            return client.sendListMessage(from, { buttonText: 'Escolher Data', description: 'Entendido. Quando você fará o follow-up?', sections: [{ title: 'Opções de Data', rows: [{ rowId: 'date_tomorrow', title: 'Amanhã' }, { rowId: 'date_2_days', title: 'Em 2 dias' }, { rowId: 'date_7_days', title: 'Em 7 dias' }, { rowId: 'date_15_days', title: 'Em 15 dias' }, { rowId: 'date_manual', title: 'Digitar data específica' }] }] });
        }
        break;
    }
    case 'client_returned': {
        if (action === 'feedback_yes') {
            await setUserState(from, { ...state, awaiting: 'follow_up_contract_closed' });
            return client.sendListMessage(from, { buttonText: 'Selecione', description: 'Entendido. E o contrato foi fechado desta vez?', sections: [{ title: 'Opções', rows: [{ rowId: 'followup_contract_yes', title: 'Sim, contrato fechado' }, { rowId: 'followup_contract_no', title: 'Não, sem contrato' }] }] });
        }
        if (action === 'feedback_no') {
            await setUserState(from, { ...state, awaiting: 'follow_up_date_selection' });
            return client.sendListMessage(from, { buttonText: 'Escolher Data', description: 'Ok. Para quando reagendamos o follow-up?', sections: [{ title: 'Opções de Data', rows: [{ rowId: 'date_tomorrow', title: 'Amanhã' }, { rowId: 'date_2_days', title: 'Em 2 dias' }, { rowId: 'date_7_days', title: 'Em 7 dias' }, { rowId: 'date_manual', title: 'Digitar data específica' }] }] });
        }
        break;
    }
    case 'follow_up_contract_closed': {
        if (action === 'followup_contract_yes' || action === 'followup_contract_no') {
            await setUserState(from, { ...state, awaiting: 'client_feedback', contractClosed: action === 'followup_contract_yes' ? 1 : 0 });
            return client.sendText(from, 'Ok. Qual foi a devolução/feedback final do cliente?');
        }
        break;
    }
    case 'client_feedback': {
        const finalStatus = state.contractClosed === 1 ? 'closed_deal' : 'feedback_received';
        return finalizeDevolution(client, from, state, { clientFeedback: message.body, status: finalStatus });
    }
    case 'follow_up_date_selection': {
        if (action === 'date_manual') {
            await setUserState(from, { ...state, awaiting: 'follow_up_date' });
            return client.sendText(from, 'Ok. Qual a data? (Envie no formato DD/MM/AAAA)');
        }
        const daysToAddMap = { date_tomorrow: 1, date_2_days: 2, date_7_days: 7, date_15_days: 15 };
        const daysToAdd = daysToAddMap[action];
        if (daysToAdd) {
            const followUpDate = new Date();
            followUpDate.setDate(followUpDate.getDate() + daysToAdd);
            return finalizeDevolution(client, from, state, { followUpDate: followUpDate.toISOString(), status: 'awaiting_client_response', followUpNotified: 0 });
        }
        break;
    }
    case 'follow_up_date': {
        const dateParts = message.body.split('/');
        if (dateParts.length !== 3 || isNaN(new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`).getTime())) {
            return client.sendText(from, 'Formato de data inválido. Use DD/MM/AAAA.');
        }
        const date = new Date(Date.UTC(dateParts[2], dateParts[1] - 1, dateParts[0]));
        return finalizeDevolution(client, from, state, { followUpDate: date.toISOString(), status: 'awaiting_client_response', followUpNotified: 0 });
    }
    case 'admin_add_user_info': {
        const [name, number] = message.body.split(',').map(s => s.trim());
        if (!name || !number || !/^\d+$/.test(number)) {
            return client.sendText(from, 'Formato inválido. Envie no formato: *Nome Completo, 55439...*');
        }
        const wppId = `${number}@c.us`;
        const existingUser = await dbGet('SELECT * FROM users WHERE wppId = ?', [wppId]);
        if(existingUser){
            await client.sendText(from, `O usuário com número ${number} já existe como "${existingUser.name}" (${existingUser.type}).`);
            await clearUserState(from);
            return sendAdminMenu(client, from, user);
        }

        await setUserState(from, { awaiting: 'admin_add_user_type', name: name, wppId: wppId });
        await client.sendListMessage(from, {
            buttonText: 'Selecionar Tipo',
            description: `Qual será o tipo do usuário *${name}*?`,
            sections: [{
                title: 'Tipos de Usuário',
                rows: [
                    { rowId: 'type_vendedor', title: 'Vendedor', description: 'Registra a devolução de amostras.' },
                    { rowId: 'type_camarista', title: 'Camarista', description: 'Entrega amostras e gerencia vendedores.' },
                    { rowId: 'type_admin', title: 'Admin', description: 'Gerencia usuários e extrai relatórios.' }
                ]
            }]
        });
        break;
    }

    case 'admin_add_user_type': {
        const type = listClickId.split('type_')[1]; // extrai 'vendedor', 'camarista' ou 'admin'
        if (!type) {
            return client.sendText(from, 'Seleção inválida. Por favor, escolha um tipo da lista.');
        }

        await dbRun('INSERT INTO users (wppId, name, type) VALUES (?, ?, ?)', [state.wppId, state.name, type]);
        await client.sendText(from, `✅ Usuário *${state.name}* adicionado com sucesso como *${type}*!`);
        await clearUserState(from);
        return sendAdminMenu(client, from, user);
    }
    
    case 'admin_select_user_for_removal': {
        const targetId = listClickId.split('admin_remove_')[1];
        const removedUser = await dbGet('SELECT name FROM users WHERE wppId = ?', [targetId]);
        await dbRun('DELETE FROM users WHERE wppId = ?', [targetId]);
        await client.sendText(from, `🗑️ Usuário *${removedUser?.name || 'desconhecido'}* foi removido com sucesso.`);
        await clearUserState(from);
        return sendAdminMenu(client, from, user);
    }
    default:
        await clearUserState(from);
        await client.sendText(from, 'Sessão expirada. Por favor, inicie novamente.');
        break;
  }
}