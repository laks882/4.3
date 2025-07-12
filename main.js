import { Actor } from 'apify';
import axios from 'axios';
import dotenv from 'dotenv';
import DiscordWebhookNotifier from './test-discord-webhook.js';

dotenv.config();

// Usage tracking configuration
const USAGE_UNIT_NAME = 'ENRICHED_RECORDS'; // Custom usage unit
const RECORDS_PER_UNIT = 1000; // Charge per 1000 records

// ✅ Helper function for sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Initialize Discord webhook notifier
const discordNotifier = new DiscordWebhookNotifier();

/**
 * Enhanced status checking with immediate termination on completion
 * @param {string} logId - The record ID to check status for
 * @param {Object} originalRequest - The original request data for notifications
 * @returns {Object} The final result data
 */
async function checkEnrichmentStatus(logId, originalRequest) {
    let result = null;
    let retries = 0;
    const maxRetries = 17280; // Maximum polling attempts

    console.log(`🔍 Starting status monitoring for record ID: ${logId}`);

    while (retries < maxRetries) {
        try {
            const statusRes = await axios.post(
                process.env.SEARCHLEADS_STATUS_URL,
                { record_id: logId },
                {
                    timeout: 30000, // 30 second timeout for each request
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }
            );

            // Handle both array and object responses
            const data = Array.isArray(statusRes.data) ? statusRes.data[0] : statusRes.data;
            const status = data?.enrichment_status;

            // Validate that we have valid data
            if (!data) {
                console.log(`⚠️ Warning: No data received in status response (Attempt ${retries + 1}/${maxRetries})`);
                await sleep(10000);
                retries++;
                continue;
            }

            console.log(`📊 Status: ${status} — Attempt ${retries + 1}/${maxRetries}`);

            // Debug: Log the raw response structure for troubleshooting (first attempt only)
            if (retries === 0) {
                console.log('🔍 Raw status response structure:', JSON.stringify(statusRes.data, null, 2));
            }

            // ✅ IMMEDIATE TERMINATION ON COMPLETION
            if (status && status.toLowerCase() === 'completed') {
                result = data;
                console.log('✅ Enrichment completed successfully! Stopping polling immediately.');
                console.log('📊 Complete result data:', JSON.stringify(data, null, 2));
                return result; // Immediate return - no further polling
            }

            // Handle failure states with Discord notifications
            if (status && status.toLowerCase() === 'failed') {
                console.log('❌ Enrichment failed. Sending Discord notification...');
                await discordNotifier.sendFailedNotification(originalRequest, data);
                throw new Error(`Enrichment failed: ${data.error_message || 'Unknown error'}`);
            }

            // Handle cancellation states with Discord notifications
            if (status && status.toLowerCase() === 'cancelled') {
                console.log('🛑 Enrichment cancelled. Sending Discord notification...');
                await discordNotifier.sendCancelledNotification(originalRequest, data);
                throw new Error(`Enrichment cancelled: ${data.cancellation_reason || 'Unknown reason'}`);
            }

            // Continue polling for InProgress and inqueue states
            if (status && (status.toLowerCase() === 'inprogress' || status.toLowerCase() === 'inqueue')) {
                console.log(`⏳ Status: ${status} - Continuing to poll...`);
                if (data.progress_percentage) {
                    console.log(`📈 Progress: ${data.progress_percentage}%`);
                }
                if (data.queue_position) {
                    console.log(`🔢 Queue position: ${data.queue_position}`);
                }
            } else if (status) {
                console.log(`⚠️ Unknown status received: ${status} - Continuing to poll...`);
            }

        } catch (error) {
            if (error.message.includes('Enrichment failed') || error.message.includes('Enrichment cancelled')) {
                throw error; // Re-throw handled errors
            }

            console.error(`🚨 Error during status check (Attempt ${retries + 1}/${maxRetries}):`, error.message);

            // Handle network timeouts and other errors gracefully
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                console.log('⏰ Request timeout - retrying...');
            } else if (error.response) {
                console.log(`📡 HTTP Error: ${error.response.status} - ${error.response.statusText}`);
            }
        }

        await sleep(10000); // Wait 10 seconds before next poll
        retries++;
    }

    // Timeout handling
    if (!result) {
        const timeoutError = new Error(`Timeout: No completion status received after ${maxRetries} attempts (${Math.round(maxRetries * 10 / 60)} minutes)`);
        console.error('⏰ Polling timeout reached:', timeoutError.message);
        throw timeoutError;
    }

    return result;
}

const run = async () => {
    await Actor.init();

    const input = await Actor.getInput();
    console.log('🚀 Starting SearchLeads enrichment process...');
    console.log('📋 Input parameters:', {
        apolloLink: input.apolloLink,
        noOfLeads: input.noOfLeads,
        fileName: input.fileName
    });

    const headers = {
        Authorization: `Bearer ${process.env.SEARCHLEADS_API_KEY}`,
        'Content-Type': 'application/json',
    };

    console.log('📤 Sending enrichment request to SearchLeads API...');
    const startRes = await axios.post(
        process.env.SEARCHLEADS_API_URL,
        {
            apolloLink: input.apolloLink,
            noOfLeads: input.noOfLeads,
            fileName: input.fileName,
        },
        { headers }
    );

    const logId = startRes.data?.record_id;
    if (!logId) {
        throw new Error('Failed to get LogID from enrichment request. Response: ' + JSON.stringify(startRes.data));
    }

    console.log(`✅ Enrichment request submitted successfully. Record ID: ${logId}`);

    // Use the enhanced status checking function
    const result = await checkEnrichmentStatus(logId, input);

    // Calculate usage based on enriched records
    const enrichedRecords = parseInt(result.enriched_records) || 0;
    const usageUnits = Math.ceil(enrichedRecords / RECORDS_PER_UNIT);

    console.log('💾 Saving final result to OUTPUT...');
    console.log('🎯 Final enrichment summary:');
    console.log(`   📊 Status: ${result.enrichment_status}`);
    console.log(`   📁 File: ${result.file_name}`);
    console.log(`   📈 Records enriched: ${result.enriched_records}`);
    console.log(`   💳 Credits used: ${result.credits_involved}`);
    console.log(`   🔗 Spreadsheet: ${result.spreadsheet_url}`);
    console.log(`   💰 Usage units charged: ${usageUnits} (${enrichedRecords} records / ${RECORDS_PER_UNIT} per unit)`);

    // Track usage for billing - this is what Apify will charge for
    if (enrichedRecords > 0) {
        const chargeResult = await Actor.charge({
            eventName: USAGE_UNIT_NAME,
            count: usageUnits
        });
        console.log(`✅ Usage tracked: ${usageUnits} units for ${enrichedRecords} enriched records`);
        console.log(`💰 Charge result:`, chargeResult);
    } else {
        console.log('⚠️ No records enriched - no usage charged');
    }

    await Actor.setValue('OUTPUT', result);

    console.log('🎉 Actor completed successfully!');
    console.log('📋 You can access the enriched data at the spreadsheet URL above.');

    await Actor.exit();
};

run();

