/**
 * BOT GERENCIADOR DE AMOSTRAS - WPPCONNECT
 * VERSÃO FINAL - COM LISTAS INTERATIVAS
 */

// --- Importações ---
const wppconnect = require('@wppconnect-team/wppconnect');
const fs = require('fs');
const cron = require('node-cron');
const { v4: uuidv4 } = require('uuid');
const exceljs = require('exceljs');

// --- Constantes ---
const DB_PATH = './database.json';

// =================================================================================================
// SEÇÃO DE MANIPULAÇÃO DO BANCO DE DADOS (JSON)
// =================================================================================================

function readDb() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Erro ao ler o banco de dados:', error);
    process.exit(1);
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error('Erro ao escrever no banco de dados:', error);
  }
}

function getUser(wppId) {
  const db = readDb();
  return db.users[wppId];
}

function getUserState(wppId) {
  const db = readDb();
  return db.userState[wppId];
}

function setUserState(wppId, state) {
  const db = readDb();
  db.userState[wppId] = state;
  writeDb(db);
}

function clearUserState(wppId) {
  const db = readDb();
  delete db.userState[wppId];
  writeDb(db);
}

function getUsersByType(type) {
  const db = readDb();
  return Object.values(db.users).filter(user => user.type === type);
}

function findSample(vendedorId, sampleId) {
  const vendedor = getUser(vendedorId);
  if (!vendedor || !vendedor.samples) return null;
  return vendedor.samples.find(s => s.sampleId === sampleId);
}

function getAdminContact() {
  return readDb().config.adminContact;
}


// =================================================================================================
// LÓGICA PRINCIPAL DO BOT
// =================================================================================================

wppconnect
  .create({
    session: 'gerenciador-amostras',
    catchQR: (base64Qr, asciiQR) => {
      console.log('Leia o QR Code com o seu celular:');
      console.log(asciiQR);
    },
    statusFind: (statusSession, session) => {
      console.log('Status da Sessão:', statusSession);
      console.log('Nome da Sessão:', session);
    },
    headless: true,
  })
  .then((client) => start(client))
  .catch((error) => console.log(error));


function start(client) {
  console.log('Bot iniciado com sucesso!');

  client.onMessage(async (message) => {
    if (message.isGroupMsg || !message.from || message.fromMe) return;

    const user = getUser(message.from);

    if (!user) {
      console.log(`Mensagem ignorada de um número não cadastrado: ${message.from}`);
      return;
    }

    const userState = getUserState(message.from);

    if (userState && userState.awaiting) {
      await handleStatefulResponse(client, message);
    } else if (user.type === 'camarista') {
      await handleCamaristaFlow(client, message);
    } else if (user.type === 'vendedor') {
      await handleVendedorFlow(client, message);
    } else if (user.type === 'admin') { // <-- ADICIONE ESTE BLOCO
      await handleAdminFlow(client, message);
    }
  });

  // --- LÓGICA DE VERIFICAÇÃO DIÁRIA ATUALIZADA (ÀS 9H) ---
  cron.schedule('0 9 * * *', async () => {
    console.log(`[${new Date().toLocaleString('pt-BR')}] CRON 9h: Verificando amostras atrasadas e follow-ups...`);
    const db = readDb();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(today.getDate() - 7);

    let dbWasModified = false;

    for (const userId in db.users) {
      const user = db.users[userId];
      if (user.type !== 'vendedor' || !user.samples || user.samples.length === 0) continue;

      // PRIMEIRO, ATUALIZA O STATUS DE TODAS AS AMOSTRAS QUE FICARAM ATRASADAS
      user.samples.forEach(sample => {
        if (sample.status === 'pending_feedback' && new Date(sample.receivedDate) < sevenDaysAgo) {
            console.log(`[CRON] Amostra ${sample.sampleId} para ${user.name} está atrasada. Mudando status para 'overdue'.`);
            sample.status = 'overdue';
            dbWasModified = true;
        }
      });

      // AGORA, ENVIA AS NOTIFICAÇÕES NECESSÁRIAS
      for (const sample of user.samples) {

        // 1. Envia lembrete para amostras "overdue"
        if (sample.status === 'overdue') {
            console.log(`[CRON] Enviando lembrete de amostra atrasada para ${user.name} (amostra ${sample.sampleId})`);
            const receivedDateFmt = new Date(sample.receivedDate).toLocaleDateString('pt-BR');
            const reminderMessage = `⚠️ *DEVOLUÇÃO ATRASADA* ⚠️\n\nA amostra de ID final *...${sample.sampleId.slice(-6)}*, retirada em ${receivedDateFmt}, está com a devolução pendente há mais de 7 dias.\n\nPor favor, procure um camarista para realizar a devolução.`;
            await client.sendText(user.wppId, reminderMessage).catch(e => console.error(`Falha ao enviar lembrete de atraso para ${user.wppId}: ${e.message}`));
        }

        // 2. Envia lembretes para follow-ups
        if (sample.status === 'awaiting_client_response' && sample.followUpDate && !sample.followUpNotified) {
            const followUpDate = new Date(sample.followUpDate);
            if (followUpDate <= today) {
              console.log(`[CRON] Lembrete de follow-up para ${user.name} sobre cliente ${sample.customerName}`);
              const messageText = `Lembrete: Você tem um follow-up agendado para hoje com o cliente *${sample.customerName}*.\n\nPor favor, inicie a devolução selecionando a opção "Dar Devolutiva de Follow-up" no seu menu.`;
              await client.sendText(user.wppId, messageText).catch(e => console.error(`Falha ao enviar lembrete de follow-up para ${user.wppId}: ${e.message}`));
              sample.followUpNotified = true;
              dbWasModified = true;
            }
          }
        }
    }

    if (dbWasModified) {
        writeDb(db);
    }
  }, {
    timezone: "America/Sao_Paulo"
  });
}

// =================================================================================================
// FLUXO DO CAMARISTA (APENAS MENUS)
// =================================================================================================

async function handleCamaristaFlow(client, message) {
  const from = message.from;
  let action = message.selectedId;

  if (!action) {
    const body = message.body.toLowerCase();
    if (body.includes('adicionar vendedor')) action = 'addVendedor';
    else if (body.includes('remover vendedor')) action = 'removeVendedor';
    else if (body.includes('entregar amostras')) action = 'deliverSamples';
    else if (body.includes('limpar amostras')) action = 'clearSamples';
  }

  switch (action) {
    case 'addVendedor':
      setUserState(from, { awaiting: 'add_vendedor_info' });
      await client.sendText(from, 'OK. Envie o nome e o número do novo vendedor no formato:\n\n*Nome do Vendedor, 5543988887777*');
      break;

    case 'removeVendedor':
      const vendedoresToRemove = getUsersByType('vendedor');
      if (vendedoresToRemove.length === 0) {
        await client.sendText(from, 'Não há vendedores para remover.');
        return sendCamaristaMenu(client, from);
      }
      const rowsToRemove = vendedoresToRemove.map(v => ({ rowId: `remove_${v.wppId}`, title: v.name, description: v.wppId.split('@')[0] }));
      await client.sendListMessage(from, {
        buttonText: 'Selecionar Vendedor',
        description: 'Quem você deseja remover?',
        sections: [{ title: 'Lista de Vendedores', rows: rowsToRemove }]
      });
      setUserState(from, { awaiting: 'select_vendor_for_removal' });
      break;

    case 'deliverSamples':
      // ATUALIZADO: Bloqueia se tiver pendência OU atraso
      const vendedoresToDeliver = getUsersByType('vendedor').filter(v => 
        !v.samples || v.samples.every(s => s.status !== 'pending_feedback' && s.status !== 'overdue')
      );
      if (vendedoresToDeliver.length === 0) {
        await client.sendText(from, 'Não há vendedores disponíveis para receber amostras. (Todos possuem pendências ou não há vendedores cadastrados).');
        return sendCamaristaMenu(client, from);
      }
      const rowsToDeliver = vendedoresToDeliver.map(v => ({ rowId: `deliver_${v.wppId}`, title: v.name, description: `${v.samples?.length || 0} amostras no total` }));
      await client.sendListMessage(from, {
        buttonText: 'Selecionar Vendedor',
        description: 'Para quem você vai entregar amostras?',
        sections: [{ title: 'Vendedores sem Pendências', rows: rowsToDeliver }]
      });
      setUserState(from, { awaiting: 'select_vendor_for_delivery' });
      break;
    
    case 'clearSamples':
        const allVendors = getUsersByType('vendedor');
        if (allVendors.length === 0) {
            await client.sendText(from, 'Não há vendedores cadastrados.');
            return sendCamaristaMenu(client, from);
        }
        const rowsToClear = allVendors.map(v => {
            // ATUALIZADO: Conta amostras pendentes E atrasadas
            const pendingCount = v.samples ? v.samples.filter(s => s.status === 'pending_feedback' || s.status === 'overdue').length : 0;
            return { 
                rowId: `clear_${v.wppId}`, 
                title: v.name, 
                description: `${pendingCount} amostra(s) pendente(s)/atrasada(s)` 
            };
        });
        await client.sendListMessage(from, {
            buttonText: 'Selecionar Vendedor',
            description: 'De qual vendedor você deseja limpar as amostras pendentes/atrasadas?',
            sections: [{ title: 'Lista de Todos os Vendedores', rows: rowsToClear }]
        });
        setUserState(from, { awaiting: 'select_vendor_for_clearance' });
        break;

    default:
      await sendCamaristaMenu(client, from);
      break;
  }
}

async function sendCamaristaMenu(client, to) {
  await client.sendListMessage(to, {
    buttonText: 'Opções',
    description: 'Menu Principal do Camarista',
    sections: [{
      title: 'Ações Disponíveis',
      rows: [
        { rowId: 'deliverSamples', title: '🚚 Entregar Amostras' },
        { rowId: 'addVendedor', title: '➕ Adicionar Vendedor' },
        { rowId: 'removeVendedor', title: '➖ Remover Vendedor' },
        { rowId: 'clearSamples', title: '🧹 Limpar Amostras de Vendedor' } // <-- OPÇÃO ADICIONADA AQUI
      ],
    }],
  });
}

// =================================================================================================
// FLUXO DO VENDEDOR (LÓGICA DE CONTORNO FINAL)
// =================================================================================================

// =================================================================================================
// FLUXO DO VENDEDOR (REESCRITO COM LÓGICA DE TEXTO ROBUSTA)
// =================================================================================================

async function handleVendedorFlow(client, message) {
  const from = message.from;
  const bodyLower = message.body.toLowerCase();
  
  // CORREÇÃO APLICADA AQUI: Unificamos a captura da ação
  // Primeiro, tentamos pegar o ID do clique na lista. Se não houver, usamos o texto.
  let action = message.selectedId || bodyLower;

  // Lógica de roteamento baseada na ação unificada
  const isStartingNewDevolution = action.includes('start_devolutiva_nova') || action.includes('devolutiva de amostra');
  const isStartingFollowUp = action.includes('start_devolutiva_followup') || action.includes('devolutiva de follow-up');
  const isSampleSelection = bodyLower.startsWith('amostra ...'); // Para quando uma amostra específica é selecionada

  // 1. O usuário quer iniciar a devolução de uma AMOSTRA NOVA
  if (isStartingNewDevolution) {
    const user = getUser(from);
    // Filtra amostras que precisam de feedback (novas ou atrasadas)
    const pendingSamples = user.samples.filter(s => s.status === 'pending_feedback' || s.status === 'overdue');
    
    if (pendingSamples.length === 0) {
      return client.sendText(from, 'Você não possui amostras com devolução pendente no momento.');
    }

    const sampleRows = pendingSamples.map(s => ({
      // O ID da linha agora é apenas o ID da amostra para simplificar
      rowId: s.sampleId, 
      title: `Amostra ...${s.sampleId.slice(-6)}`,
      description: `Recebida em ${new Date(s.receivedDate).toLocaleDateString('pt-BR')}`
    }));

    await client.sendListMessage(from, {
      buttonText: 'Selecionar Amostra',
      description: 'Qual amostra você está dando o feedback?',
      sections: [{ title: 'Suas Amostras Pendentes', rows: sampleRows }]
    });
    // Define um estado para aguardar a seleção da amostra
    setUserState(from, { awaiting: 'select_sample_for_devolution' });

  // 2. O usuário quer iniciar a devolução de um FOLLOW-UP
  } else if (isStartingFollowUp) {
    const user = getUser(from);
    const followupSamples = user.samples.filter(s => s.status === 'awaiting_client_response');
    
    if (followupSamples.length === 0) {
      return client.sendText(from, 'Você não possui nenhum follow-up agendado no momento.');
    }

    const sampleRows = followupSamples.map(s => ({
      rowId: s.sampleId, // ID da amostra para simplificar
      title: `Amostra ...${s.sampleId.slice(-6)}`,
      description: `Cliente: ${s.customerName} | Agendado para: ${new Date(s.followUpDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`
    }));

    await client.sendListMessage(from, {
      buttonText: 'Selecionar Follow-up',
      description: 'De qual follow-up você dará a devolução?',
      sections: [{ title: 'Seus Follow-ups Agendados', rows: sampleRows }]
    });
    // Define um estado para aguardar a seleção da amostra
    setUserState(from, { awaiting: 'select_sample_for_followup' });
  
  // 3. O usuário selecionou uma AMOSTRA ESPECÍFICA (não é mais necessário com a nova lógica de estado)
  // A lógica de seleção foi movida para dentro do handleStatefulResponse para maior clareza.

  // 4. Se não for nenhum dos comandos acima, mostra o MENU PRINCIPAL
  } else {
    const user = getUser(from);
    await client.sendListMessage(from, {
        buttonText: 'Opções',
        description: `Olá, *${user.name}*! Selecione uma ação.`,
        sections: [{
            title: 'Ações de Devolutiva',
            rows: [ 
                { rowId: 'start_devolutiva_nova', title: 'Dar Devolutiva de Amostra' },
                { rowId: 'start_devolutiva_followup', title: 'Dar Devolutiva de Follow-up' }
            ]
        }]
    });
  }
}

async function handleAdminFlow(client, message) {
  console.log('✅ [ADMIN] Fluxo do admin iniciado.');

  const from = message.from;
  
  // =======================================================================
  // CORREÇÃO APLICADA AQUI: O ID da lista vem neste caminho específico
  const action = message.listResponse?.singleSelectReply?.selectedRowId;
  // =======================================================================

  console.log(`▶️ [ADMIN] Ação recebida: ${action}`);

  // O restante do código não precisa de alterações
  switch (action) {
    case 'report_all_samples':
      let reportPath = null; // Declarar aqui para o finally ter acesso
      try {
        await client.sendText(from, '⚙️ Gerando o relatório completo de amostras... Aguarde um momento.');
        console.log('[ADMIN] Iniciando a geração do Excel...');
        
        reportPath = await generateGeneralReportExcel();
        console.log(`[ADMIN] Arquivo Excel criado em: ${reportPath}`);
        
        const fileName = `Relatorio_Geral_Amostras_${new Date().toISOString().split('T')[0]}.xlsx`;
        await client.sendFile(from, reportPath, fileName, '📄 Aqui está o relatório completo de todas as amostras.');
        console.log('[ADMIN] Relatório enviado com sucesso!');

      } catch (error) {
        console.error("❌❌❌ ERRO CRÍTICO NO BLOCO TRY/CATCH ❌❌❌");
        console.error(error);
        await client.sendText(from, '❌ Ocorreu um erro ao gerar o relatório. Verifique o console do servidor para mais detalhes.');
      
      } finally {
        if (reportPath && fs.existsSync(reportPath)) {
            console.log(`[ADMIN] Limpando arquivo temporário: ${reportPath}`);
            fs.unlinkSync(reportPath);
        }
      }
      break;

    default:
      console.log(`[ADMIN] Ação "${action}" não reconhecida. Enviando menu principal.`);
      await sendAdminMenu(client, from);
      break;
  }
}

async function sendAdminMenu(client, to) {
  const user = getUser(to);
  await client.sendListMessage(to, {
    buttonText: 'Opções de Admin',
    description: `Olá, *${user.name}*! Selecione o relatório que deseja extrair.`,
    sections: [{
      title: 'Relatórios Disponíveis',
      rows: [
        { rowId: 'report_all_samples', title: '📊 Relatório Geral de Amostras' }
        // Futuramente, outros relatórios podem ser adicionados aqui
      ],
    }],
  });
}

async function generateGeneralReportExcel() {
  const db = readDb();
  const workbook = new exceljs.Workbook();
  const worksheet = workbook.addWorksheet('Relatório de Amostras');

  // Mapeamento de status para nomes amigáveis
  const statusMap = {
    pending_feedback: 'Pendente Feedback',
    overdue: 'Atrasada',
    awaiting_client_response: 'Aguardando Cliente',
    closed_deal: 'Contrato Fechado',
    feedback_received: 'Feedback Recebido (Sem Venda)',
  };

  // Definir colunas
  worksheet.columns = [
    { header: 'Vendedor', key: 'vendedor', width: 25 },
    { header: 'Status', key: 'status', width: 25 },
    { header: 'Cliente', key: 'cliente', width: 25 },
    { header: 'Contrato Fechado', key: 'contrato', width: 20 },
    { header: 'Data de Recebimento', key: 'recebimento', width: 20 },
    { header: 'Data do Follow-up', key: 'followup', width: 20 },
    { header: 'ID da Amostra', key: 'id', width: 40 },
    { header: 'Feedback do Cliente', key: 'feedback', width: 50 },
  ];

  // Estilizar o cabeçalho
  worksheet.getRow(1).font = { bold: true };

  // Iterar por todos os usuários para encontrar vendedores e suas amostras
  for (const userId in db.users) {
    const user = db.users[userId];
    if (user.type === 'vendedor' && user.samples && user.samples.length > 0) {
      for (const sample of user.samples) {
        worksheet.addRow({
          vendedor: user.name || 'Nome não encontrado',
          status: statusMap[sample.status] || sample.status,
          cliente: sample.customerName || '-',
          contrato: typeof sample.contractClosed === 'boolean' ? (sample.contractClosed ? 'Sim' : 'Não') : '-',
          recebimento: new Date(sample.receivedDate).toLocaleDateString('pt-BR'),
          followup: sample.followUpDate ? new Date(sample.followUpDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' }) : '-',
          id: sample.sampleId,
          feedback: sample.clientFeedback || '-',
        });
      }
    }
  }

  const filePath = `./relatorio_temp_${uuidv4()}.xlsx`;
  await workbook.xlsx.writeFile(filePath);
  return filePath;
}

async function handleStatefulResponse(client, message) {
  const from = message.from;
  const state = getUserState(from);
  const bodyLower = message.body.toLowerCase();

  const listClickId = message.listResponse?.singleSelectReply?.selectedRowId;

  switch (state.awaiting) {
    // --- ESTADOS DO VENDEDOR (NOVOS E CORRIGIDOS) ---
    case 'select_sample_for_devolution': {
        const sampleId = listClickId;
        if (!sampleId) {
            clearUserState(from);
            await client.sendText(from, 'Houve um erro ao processar sua seleção. Por favor, tente novamente a partir do menu.');
            return handleVendedorFlow(client, { from, body: 'fake_message_to_show_menu' });
        }
        const user = getUser(from);
        const foundSample = user.samples.find(s => s.sampleId === sampleId);
        if (!foundSample) {
            clearUserState(from);
            await client.sendText(from, 'Não consegui identificar essa amostra. Por favor, tente novamente a partir do menu.');
            return handleVendedorFlow(client, { from, body: 'fake_message_to_show_menu' });
        }
        setUserState(from, { awaiting: 'customer_name', currentSampleId: foundSample.sampleId });
        await client.sendText(from, `Ótimo! Sobre a amostra *...${sampleId.slice(-6)}*:\n\nPara qual cliente foi?`);
        break;
    }

    case 'select_sample_for_followup': {
        const sampleId = listClickId;
        if (!sampleId) {
            clearUserState(from);
            await client.sendText(from, 'Houve um erro ao processar sua seleção. Por favor, tente novamente a partir do menu.');
            return handleVendedorFlow(client, { from, body: 'fake_message_to_show_menu' });
        }
        const user = getUser(from);
        const foundSample = user.samples.find(s => s.sampleId === sampleId);
        if (!foundSample) {
            clearUserState(from);
            await client.sendText(from, 'Não consegui identificar essa amostra. Por favor, tente novamente a partir do menu.');
            return handleVendedorFlow(client, { from, body: 'fake_message_to_show_menu' });
        }
        setUserState(from, { 
            awaiting: 'client_returned', 
            currentSampleId: foundSample.sampleId,
            customerName: foundSample.customerName,
            contractClosed: foundSample.contractClosed
        });
        await client.sendListMessage(from, {
            buttonText: 'Selecione',
            description: `Devolutiva do follow-up com o cliente *${foundSample.customerName}*.\n\nO cliente já deu o feedback final?`,
            sections: [{
                title: 'Opções',
                rows: [
                    { rowId: 'feedback_yes', title: 'Sim (deu feedback)' },
                    { rowId: 'feedback_no', title: 'Não (reagendar visita)' }
                ]
            }]
        });
        break;
    }

    // --- ESTADOS DO CAMARISTA (COMPLETO) ---
    case 'add_vendedor_info': {
        const [name, number] = message.body.split(',').map(s => s.trim());
        if (!name || !number || !/^\d+$/.test(number)) {
            return client.sendText(from, 'Formato inválido. Por favor, envie no formato: `Nome do Vendedor, 5543988887777`');
        }
        const wppId = `${number}@c.us`;
        const db = readDb();
        if (db.users[wppId]) {
            await client.sendText(from, 'Este número já está cadastrado.');
        } else {
            db.users[wppId] = { name, type: 'vendedor', wppId, samples: [] };
            writeDb(db);
            await client.sendText(from, `✅ Vendedor *${name}* adicionado com sucesso!`);
        }
        clearUserState(from);
        return sendCamaristaMenu(client, from);
    }

    case 'select_vendor_for_delivery':
    case 'select_vendor_for_removal':
    case 'select_vendor_for_clearance': {
        let targetId = listClickId ? listClickId.split('_')[1] : null;

        if (!targetId) {
            const vendors = getUsersByType('vendedor');
            const foundVendor = vendors.find(v => message.body.toLowerCase().startsWith(v.name.toLowerCase()));
            if (foundVendor) {
                targetId = foundVendor.wppId;
            }
        }

        if (!targetId) {
            return client.sendText(from, 'Vendedor não encontrado. Por favor, selecione um da lista.');
        }

        const targetState = state.awaiting;

        if (targetState === 'select_vendor_for_removal') {
            const db = readDb();
            const vendedorName = db.users[targetId]?.name || 'desconhecido';
            delete db.users[targetId];
            writeDb(db);
            await client.sendText(from, `🗑️ Vendedor *${vendedorName}* removido com sucesso.`);
            clearUserState(from);
            return sendCamaristaMenu(client, from);
        } else if (targetState === 'select_vendor_for_delivery') {
            const vendedor = getUser(targetId);
            setUserState(from, { awaiting: 'deliver_samples_quantity', selectedVendedorId: targetId });
            return client.sendText(from, `Quantas amostras você entregou para *${vendedor.name}*?`);
        } else if (targetState === 'select_vendor_for_clearance') {
            const vendedor = getUser(targetId);
            setUserState(from, { awaiting: 'confirm_clearance', vendorToClearId: targetId });
            return client.sendListMessage(from, {
                buttonText: 'Confirmar',
                description: `Você tem certeza que deseja limpar TODAS as amostras pendentes e atrasadas de *${vendedor.name}*? Esta ação não pode ser desfeita.`,
                sections: [{
                    title: 'Confirmação',
                    rows: [
                        { rowId: 'confirm_clear_yes', title: 'Sim, limpar amostras' },
                        { rowId: 'confirm_clear_no', title: 'Não, cancelar' }
                    ]
                }]
            });
        }
        break; // Adicionado para consistência
    }

    case 'confirm_clearance': {
        const isYes = listClickId === 'confirm_clear_yes' || bodyLower.includes('sim');
        const isNo = listClickId === 'confirm_clear_no' || bodyLower.includes('não');

        if (isNo) {
            clearUserState(from);
            await client.sendText(from, 'Ação cancelada.');
            return sendCamaristaMenu(client, from);
        }

        if (isYes) {
            const db = readDb();
            const vendorToClearId = state.vendorToClearId;
            const vendedor = db.users[vendorToClearId];
            
            if (vendedor && vendedor.samples) {
                const originalCount = vendedor.samples.filter(s => s.status === 'pending_feedback' || s.status === 'overdue').length;
                vendedor.samples = vendedor.samples.filter(s => s.status !== 'pending_feedback' && s.status !== 'overdue');
                writeDb(db);
                await client.sendText(from, `✅ *${originalCount}* amostra(s) pendente(s)/atrasada(s) de *${vendedor.name}* foram limpas com sucesso.`);
            } else {
                await client.sendText(from, 'Vendedor não encontrado ou sem amostras para limpar.');
            }
            clearUserState(from);
            return sendCamaristaMenu(client, from);
        } else {
            return client.sendText(from, 'Resposta inválida. Por favor, selecione uma opção da lista.');
        }
    }

    case 'deliver_samples_quantity': {
        const quantity = parseInt(message.body);
        if (isNaN(quantity) || quantity <= 0) {
            return client.sendText(from, 'Por favor, envie um número válido de amostras.');
        }
        const db = readDb();
        const vendedorId = state.selectedVendedorId;
        const vendedor = db.users[vendedorId];

        if (!Array.isArray(vendedor.samples)) {
            vendedor.samples = [];
        }

        for (let i = 0; i < quantity; i++) {
            vendedor.samples.push({
                sampleId: uuidv4(),
                receivedDate: new Date().toISOString(),
                status: 'pending_feedback'
            });
        }
        writeDb(db);
        await client.sendText(from, `✅ *${quantity}* amostra(s) registrada(s) para *${vendedor.name}*.`);
        
        clearUserState(from);
        await sendCamaristaMenu(client, from);

        try {
            const numberStatus = await client.checkNumberStatus(vendedorId);
            if (numberStatus.numberExists) {
                const notificationDescription = `Olá, *${vendedor.name}*!\n\nVocê recebeu *${quantity}* nova(s) amostra(s) de produtos *YUP* hoje.\n\n*Atenção:* Você tem até *7 dias* para dar o feedback das prospecções ou fazer a devolução das amostras!`;
                await client.sendListMessage(vendedorId, {
                    buttonText: 'Ações de Amostra',
                    description: notificationDescription,
                    sections: [{
                        title: 'Opções Disponíveis',
                        rows: [
                            { rowId: 'start_devolutiva_nova', title: 'Dar Devolutiva de Amostra' }
                        ]
                    }]
                });
            } else {
                console.error(`FALHA NA NOTIFICAÇÃO: O número ${vendedorId} (Vendedor: ${vendedor.name}) não foi encontrado no WhatsApp.`);
                await client.sendText(from, `⚠️ *Atenção:* Não foi possível notificar o vendedor *${vendedor.name}* pois o número de telefone parece ser inválido ou não ter WhatsApp.`);
            }
        } catch (e) {
            console.error(`Erro inesperado ao notificar o vendedor ${vendedorId}:`, e.message);
        }
        return;
    }
    
    // --- FLUXO DO VENDEDOR (LÓGICA DE CONVERSA COMPLETA E CORRIGIDA) ---
    case 'customer_name': {
        setUserState(from, { ...state, awaiting: 'contract_closed', customerName: message.body });
        return client.sendListMessage(from, {
            buttonText: 'Selecione',
            description: 'Entendido. E você fechou contrato com este cliente?',
            sections: [{
                title: 'Opções',
                rows: [
                    { rowId: 'contract_yes', title: 'Sim' },
                    { rowId: 'contract_no', title: 'Não' }
                ]
            }]
        });
    }

    case 'contract_closed': {
        const isYes = listClickId === 'contract_yes' || bodyLower.includes('sim');
        const isNo = listClickId === 'contract_no' || bodyLower.includes('não');

        if (isYes) {
            const db = readDb();
            const sampleIndex = db.users[from].samples.findIndex(s => s.sampleId === state.currentSampleId);
            const vendedor = db.users[from];
            const updates = { ...state, awaiting: undefined, contractClosed: true, status: 'closed_deal' };
            if (sampleIndex !== -1) {
                db.users[from].samples[sampleIndex] = { ...db.users[from].samples[sampleIndex], ...updates };
                writeDb(db);
            }
            await client.sendText(from, '✅ Devolutiva registrada com sucesso! Obrigado!');
            clearUserState(from);
            try { await sendFinalReport(client, vendedor, db.users[from].samples[sampleIndex]); } catch (e) { console.error('Falha ao enviar relatório final:', e.message); }
            return handleVendedorFlow(client, { from, body: 'fake_message_to_show_menu' });
        } else if (isNo) {
            setUserState(from, { ...state, awaiting: 'initial_feedback_or_followup', contractClosed: false });
            return client.sendListMessage(from, {
                buttonText: 'Selecione',
                description: 'Entendido. E qual o próximo passo com o cliente?',
                sections: [{
                    title: 'Opções',
                    rows: [
                        { rowId: 'get_final_feedback', title: 'Já tenho o feedback final' },
                        { rowId: 'schedule_followup', title: 'Preciso agendar um follow-up' }
                    ]
                }]
            });
        } else {
            return client.sendText(from, 'Resposta inválida. Por favor, selecione uma opção da lista.');
        }
    }

    case 'initial_feedback_or_followup': {
        const isFinalFeedback = listClickId === 'get_final_feedback' || bodyLower.includes('feedback final');
        const isScheduleFollowup = listClickId === 'schedule_followup' || bodyLower.includes('agendar');

        if (isFinalFeedback) {
            setUserState(from, { ...state, awaiting: 'client_feedback' });
            return client.sendText(from, 'Ok. Qual foi a devolução/feedback final do cliente?');
        } else if (isScheduleFollowup) {
            setUserState(from, { ...state, awaiting: 'follow_up_date' });
            return client.sendText(from, 'Entendido. Qual a data provável para o cliente responder? (Envie no formato DD/MM/AAAA)');
        } else {
            return client.sendText(from, 'Resposta inválida. Por favor, selecione uma opção da lista.');
        }
    }

    case 'client_returned': {
        const isYes = listClickId === 'feedback_yes' || bodyLower.includes('sim');
        const isNo = listClickId === 'feedback_no' || bodyLower.includes('não');

        if (isYes) {
            setUserState(from, { ...state, awaiting: 'follow_up_contract_closed' });
            return client.sendListMessage(from, {
                buttonText: 'Selecione',
                description: 'Entendido. E o contrato foi fechado desta vez?',
                sections: [{
                    title: 'Opções',
                    rows: [
                        { rowId: 'followup_contract_yes', title: 'Sim, contrato fechado' },
                        { rowId: 'followup_contract_no', title: 'Não, sem contrato' }
                    ]
                }]
            });
        } else if (isNo) {
            setUserState(from, { ...state, awaiting: 'follow_up_date' });
            return client.sendText(from, 'Entendido. Qual a nova data provável para o cliente responder? (Envie no formato DD/MM/AAAA)');
        } else {
            return client.sendText(from, 'Resposta inválida. Por favor, selecione uma opção da lista.');
        }
    }

    case 'follow_up_contract_closed': {
        const isYes = listClickId === 'followup_contract_yes' || bodyLower.includes('sim');
        const isNo = listClickId === 'followup_contract_no' || bodyLower.includes('não');

        if (isYes || isNo) {
            const contractClosed = isYes;
            setUserState(from, { ...state, awaiting: 'client_feedback', contractClosed: contractClosed });
            return client.sendText(from, 'Ok. Qual foi a devolução/feedback final do cliente?');
        } else {
            return client.sendText(from, 'Resposta inválida. Por favor, selecione uma opção da lista.');
        }
    }

    case 'client_feedback': {
        const db = readDb();
        const sampleIndex = db.users[from].samples.findIndex(s => s.sampleId === state.currentSampleId);
        const vendedor = db.users[from];
        const finalStatus = state.contractClosed ? 'closed_deal' : 'feedback_received';
        const updates = { ...state, awaiting: undefined, clientFeedback: message.body, status: finalStatus };
        if (sampleIndex !== -1) {
            db.users[from].samples[sampleIndex] = { ...db.users[from].samples[sampleIndex], ...updates };
            writeDb(db);
        }
        await client.sendText(from, '✅ Devolutiva registrada com sucesso! Obrigado!');
        clearUserState(from);
        try { await sendFinalReport(client, vendedor, db.users[from].samples[sampleIndex]); } catch (e) { console.error('Falha ao enviar relatório final:', e.message); }
        return handleVendedorFlow(client, { from, body: 'fake_message_to_show_menu' });
    }

    case 'follow_up_date': {
        const dateParts = message.body.split('/');
        if (dateParts.length !== 3 || isNaN(new Date(`${dateParts[2]}-${dateParts[1]}-${dateParts[0]}`).getTime())) {
            return client.sendText(from, 'Formato de data inválido. Use DD/MM/AAAA.');
        }
        const date = new Date(Date.UTC(dateParts[2], dateParts[1] - 1, dateParts[0]));
        const db = readDb();
        const sampleIndex = db.users[from].samples.findIndex(s => s.sampleId === state.currentSampleId);
        const vendedor = db.users[from];
        const updates = { ...state, awaiting: undefined, followUpDate: date.toISOString(), status: 'awaiting_client_response', followUpNotified: false };
        if (sampleIndex !== -1) {
            db.users[from].samples[sampleIndex] = { ...db.users[from].samples[sampleIndex], ...updates };
            writeDb(db);
        }
        await client.sendText(from, `✅ Ok, agendado! Te lembrarei na data. Obrigado!`);
        clearUserState(from);
        try { await sendFinalReport(client, vendedor, db.users[from].samples[sampleIndex]); } catch (e) { console.error('Falha ao enviar relatório final:', e.message); }
        return handleVendedorFlow(client, { from, body: 'fake_message_to_show_menu' });
    }

    default:
        clearUserState(from);
        await client.sendText(from, 'Sessão expirada. Por favor, inicie novamente.');
        break;
  }
}

async function sendFinalReport(client, vendedor, sampleData) {
  const adminContact = getAdminContact();
  if (!adminContact) {
    console.error("Contato do admin não configurado. Relatório não pode ser enviado.");
    return;
  }

  if (!sampleData || !vendedor) {
    console.error(`Relatório não pôde ser gerado: dados do vendedor ou da amostra estão faltando.`);
    return;
  }

  try {
    const numberStatus = await client.checkNumberStatus(adminContact);
    if (!numberStatus.numberExists) {
        console.error(`FALHA NO RELATÓRIO: O número do admin ${adminContact} não foi encontrado no WhatsApp.`);
        return;
    }

    const statusMap = {
        closed_deal: '✅ Contrato Fechado',
        awaiting_client_response: '🗓️ Aguardando Resposta do Cliente',
        feedback_received: '🗣️ Feedback Recebido (Sem Venda)',
        pending_feedback: '⏳ Devolução Ainda Pendente'
    };

    const friendlyStatus = statusMap[sampleData.status] || sampleData.status;

    let report = `🔔 *Relatório de Devolutiva de Amostra* 🔔\n\n`;
    report += `*Vendedor:* ${vendedor.name}\n`;
    report += `*Amostra ID:* ...${sampleData.sampleId.slice(-6)}\n`;
    report += `*Cliente:* ${sampleData.customerName || 'Não informado'}\n`;
    report += `*Contrato Fechado:* ${'contractClosed' in sampleData ? (sampleData.contractClosed ? '✅ Sim' : '❌ Não') : 'Não informado'}\n`;

    if (sampleData.clientFeedback) {
      report += `*Feedback do Cliente:* ${sampleData.clientFeedback}\n`;
    }
    if (sampleData.followUpDate) {
      // CORREÇÃO DE TIMEZONE APLICADA AQUI
      report += `*Data para Follow-up:* ${new Date(sampleData.followUpDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}\n`;
    }
    report += `\n*Status Final:* ${friendlyStatus}`;

    await client.sendText(adminContact, report);
  } catch(e) {
      console.error(`Erro inesperado ao enviar relatório para o Admin ${adminContact}:`, e.message);
  }
}