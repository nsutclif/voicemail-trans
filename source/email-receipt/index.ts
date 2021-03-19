"use strict";

// The Email Receipt lambda triggers when we receive a notification from SES.
// Its job is to download and delete all the messages in the voip.ms account.
// I originally hoped to download all messages in separate parallel Lambda functions,
// but the only stable way I can see to use the voip.ms API is to treat it as a queue -
// keep downloading the first message and deleting it until no more remain.
// In theory, this Lambda might be better as a Step Function, but in practice, 
// there is normally only going to be one voicemail to download anyway.

import * as crypto from "crypto";
import { performance } from "perf_hooks";

import { Context } from "aws-lambda";
import { metricScope, MetricsLogger } from "aws-embedded-metrics";

import * as AWSRaw from "aws-sdk";
import { captureAWS, captureAsyncFunc } from "aws-xray-sdk";
const AWS = captureAWS(AWSRaw);

import { DocumentClient } from "aws-sdk/lib/dynamodb/document_client";

import * as moment from "moment";
import * as rpn from "request-promise-native";

const documentClient: DocumentClient = new AWSRaw.DynamoDB.DocumentClient();
const s3: AWS.S3 = new AWS.S3();

import * as log from "loglevel";
log.setLevel((process.env.LOG_LEVEL as log.LogLevelDesc) || "info");

interface DevConfig {
    voipMSPassword: string;
    voipMSUser: string;
    voipMSMailbox: string;
    notificationEmail: string[];
    notificationSMS: string[];
}

// TODO: What are voip.ms "folders" for?

// async function getVoicemailFolders(): Promise<any> {
//     const rpcURL: string = getBaseRequestURL() +
//         `&method=getVoicemailFolders`;

//     console.log(rpcURL);

//     return JSON.parse(await rpn(rpcURL));
// }

const cachedConfig: DevConfig = null;
async function getDevConfig(): Promise<DevConfig> {
    let result: DevConfig = cachedConfig;
    if (!result) {
        const getObjectResult = await s3
            .getObject({
                Bucket: process.env.ConfigurationBucketName,
                Key: process.env.ConfigurationKey,
            })
            .promise();

        result = JSON.parse(getObjectResult.Body.toString()) as DevConfig;
    }

    return result;
}

function getBaseRequestURL(devConfig: DevConfig): string {
    return `https://voip.ms/api/v1/rest.php?api_username=${devConfig.voipMSUser}&api_password=${devConfig.voipMSPassword}`;
}

interface SavedVoipMSVoicemail {
    tenantidmailbox: string;
    message_num: string; // eslint-disable-line camelcase
    date: string;
    callerid: string;
    duration: string;
}

// These are the properties that Voip.ms returns about voicemails.
interface VoipMSVoicemail extends SavedVoipMSVoicemail {
    mailbox: string;
    folder: string;
    message_num: string; // eslint-disable-line camelcase
    date: string;
    callerid: string;
    duration: string;
    urgent: string;
    listened: string;
}

interface GetVoicemailMessagesResponseDTO {
    status: "success" | "no_messages";
    messages: VoipMSVoicemail[];
}

// If we're going to be iterating through the mailbox, deleting voicemails as we go,
// we can't have some other instance of the function doing the same thing at the
// same time.
// Returns true if the mailbox was successfully locked.
// Returns false if the mailbox was alread locked (by someone else).
// Throws an error if something goes wrong.
async function lockMailbox(
    devConfig: DevConfig,
    remainingExecutionMS: number,
): Promise<boolean> {
    let success = true;

    try {
        const expirationTime: Date = new Date(
            Date.now() + remainingExecutionMS,
        );

        const params: DocumentClient.UpdateItemInput = {
            TableName: process.env.MAILBOX_LOCK_TABLE_NAME,
            Key: { tenantidmailbox: devConfig.voipMSMailbox },
            UpdateExpression: "set expirationTime = :expirationTime",
            ConditionExpression:
                "attribute_not_exists(expirationTime) OR expirationTime < :currentTime",
            ExpressionAttributeValues: {
                ":expirationTime": expirationTime.getTime() / 1000, // Must save to "epoch" format for DynamoDB TTL feature to work
                ":currentTime": new Date().getTime() / 1000,
            },
        };

        await documentClient.update(params).promise();
    } catch (e) {
        if (e.code === "ConditionalCheckFailedException") {
            success = false;
        } else {
            throw new Error(
                `Error locking mailbox id ${devConfig.voipMSMailbox}: ${e.message}`,
            );
        }
    }

    return success;

    // TODO: Catch error if mailbox can't be locked:
    // {"errorType":"ConditionalCheckFailedException","errorMessage":"The conditional request failed"}
}

async function unlockMailbox(devConfig: DevConfig): Promise<void> {
    await documentClient
        .delete({
            TableName: process.env.MAILBOX_LOCK_TABLE_NAME,
            Key: { tenantidmailbox: devConfig.voipMSMailbox },
        })
        .promise();
}

async function getResponse<T>(
    functionName: string,
    rpcURL: string,
    devConfig: DevConfig,
    metrics: MetricsLogger,
): Promise<T> {
    // Make the request to Voip.ms, logging metrics and capturing an x-ray segment

    log.trace(
        `Calling ${functionName}: ${rpcURL.replace(
            devConfig.voipMSPassword,
            "xxxxxxxx",
        )}`,
    );

    const startTime: number = performance.now();

    let response: string;
    // NOTE: captureAsyncFunc doesn't seem to work properly before the 3.0.0 release (in alpha as of this comment):
    // https://github.com/aws/aws-xray-sdk-node/issues/60
    await captureAsyncFunc(functionName, async function(subsegment) {
        response = await rpn(rpcURL);
        subsegment.close();
    });

    const duration: number = performance.now() - startTime;

    const jsonResponse: T = JSON.parse(response);

    metrics.putMetric(`${functionName}Elapsed`, duration, "Milliseconds");
    metrics.putMetric(`${functionName}Bytes`, response.length, "Bytes");

    if ((jsonResponse as any).status) {
        log.trace(
            "Response status: " +
                JSON.stringify((jsonResponse as any).status, null, 2),
        );
    }

    return jsonResponse;
}

async function getFirstVoicemailDetails(
    devConfig: DevConfig,
    metrics: MetricsLogger,
): Promise<VoipMSVoicemail> {
    const rpcURL =
        getBaseRequestURL(devConfig) +
        `&method=getVoicemailMessages&mailbox=${devConfig.voipMSMailbox}`;

    // This is what you get back when there are no messages:
    // { status: 'no_messages' }

    // This is what you get back when there are messages:
    // {
    //     "status": "success",
    //     "messages": [
    //         {
    //             "mailbox": "999999",
    //             "folder": "INBOX",
    //             "message_num": "2",     <------- NOTE: They aren't sorted by message_num or date
    //             "date": "2019-01-17 09:13:25",  <---- Seems to be local time (at the voip.ms server?)
    //             "callerid": "ABBOTSFORD, BC <6045555555>",
    //             "duration": "00:00:05",
    //             "urgent": "no",
    //             "listened": "no"
    //         },
    //         {
    //             "mailbox": "999999",
    //             "folder": "INBOX",
    //             "message_num": "0",
    //             "date": "2019-01-11 14:21:05",
    //             "callerid": "ABBOTSFORD, BC <6045555555>",
    //             "duration": "00:00:03",
    //             "urgent": "no",
    //             "listened": "no"
    //         },
    //         {
    //             "mailbox": "999999",
    //             "folder": "INBOX",
    //             "message_num": "1",
    //             "date": "2019-01-17 09:12:49",
    //             "callerid": "ABBOTSFORD, BC <6045555555>",
    //             "duration": "00:00:08",
    //             "urgent": "no",
    //             "listened": "no"
    //         }
    //     ]
    // }

    const responseDTO = await getResponse<GetVoicemailMessagesResponseDTO>(
        "getVoicemailMessages",
        rpcURL,
        devConfig,
        metrics,
    );

    let messageZero: VoipMSVoicemail;
    if (responseDTO.status !== "no_messages") {
        if (
            !Array.isArray(responseDTO.messages) ||
            responseDTO.messages.length === 0
        ) {
            throw new Error(
                "Voip.MS responded that there were messages, but it didn't return them.",
            );
        }
        // Return the message with message_num === 0.  It's probably the first one, but no guarantee.
        messageZero = responseDTO.messages.find((message: VoipMSVoicemail) => {
            return message.message_num === "0";
        });
        if (!messageZero) {
            throw new Error(
                "Could not find message with message_num === 0 in repsonse.",
            );
        }
    }

    return messageZero;
}

// Returns the key of the downloaded file.
async function downloadVoicemail(
    devConfig: DevConfig,
    voicemail: VoipMSVoicemail,
    metrics: MetricsLogger,
): Promise<void> {
    // TODO: Make sure the date of the voicemail includes the timezone.
    // I suspect it's in the local time of voip.ms's server

    const parsedDate: moment.Moment = moment(voicemail.date);

    // Create an ID for this voicemail that:
    // - uniquely identifies the original voicemail
    // - is sortable by date
    // - is a valid name for an S3 object
    // - is a valid name for a transcription job

    const voicemailID: string =
        parsedDate.format("YYYYMMDDHHmmssSSS") +
        "-" +
        crypto
            .createHash("md5")
            .update(JSON.stringify(voicemail))
            .digest("hex");

    const rpcURL: string =
        getBaseRequestURL(devConfig) +
        `&method=getVoicemailMessageFile&mailbox=${voicemail.mailbox}&folder=${voicemail.folder}&message_num=0&format=mp3`;
    // https://stackoverflow.com/questions/31666314/piping-from-request-js-to-s3-upload-results-in-a-zero-byte-file

    const jsonResponse = await getResponse<any>(
        "getVoicemailMessageFile",
        rpcURL,
        devConfig,
        metrics,
    );

    if (jsonResponse.status !== "success") {
        throw new Error(`Voip.ms responded with status ${jsonResponse.status}`);
    }

    await s3
        .upload({
            Body: Buffer.from(jsonResponse.message.data, "base64"),
            Bucket: process.env.VOICEMAIL_AUDIO_BUCKET_NAME,
            Key: `${voicemail.mailbox}/${voicemail.folder}/${voicemailID}.mp3`,
            // The add-voicemail-to-index Lambda will move this metadata straight to Dynamo:
            Metadata: {
                tenantid: voicemail.mailbox, // FUTURE: Change this
                voicemailid: voicemailID, // lower case because S3 seems to make everything lower case
                mailbox: voicemail.mailbox,
                date: voicemail.date,
                callerid: voicemail.callerid,
                duration: voicemail.duration,
                urgent: voicemail.urgent,
                folder: voicemail.folder,
            },
        })
        .promise();

    // The following code downloads a file from a URL and streams it directly to S3.
    // Unfortunately we have to parse (decode base64) the response...
    // TODO: Can we decode it while streaming it to S3?  In pratice, these S3 objects shouldn't be too large.

    // return new Promise((resolve, reject) => {
    //     try {
    //         // https.request() returns a readable stream that we pass to the S3 client.
    //         // This way we're streaming from the URL directly to S3 without having
    //         // to store the entire file in RAM or on the file system
    //         const request = https.request(url, (response: http.IncomingMessage) => {
    //             console.log(`response status code: ${response.statusCode}`);
    //             console.log(`response headers: ${JSON.stringify(response.headers, null, 2)}`);
    //             s3.upload({
    //                 Body: response,
    //                 Bucket: bucketName,
    //                 Key: key,
    //             }, (err) => {
    //               if (err) {
    //                   // This would be an error related to the upload to S3.
    //                   reject(err);
    //               } else {
    //                   resolve();
    //               }
    //           });
    //         })

    //         request.on("error", (e) => {
    //             // This would be an error related to the download from the URL
    //             reject(e);
    //         });

    //         request.end();
    //     } catch (e) {
    //         reject(e);
    //     }
    // });
}

async function deleteVoicemail(
    devConfig: DevConfig,
    voicemail: VoipMSVoicemail,
    metrics: MetricsLogger,
): Promise<void> {
    const rpcURL: string =
        getBaseRequestURL(devConfig) +
        `&method=delMessages&mailbox=${voicemail.mailbox}&folder=${voicemail.folder}&message_num=0&format=mp3`;
    // https://stackoverflow.com/questions/31666314/piping-from-request-js-to-s3-upload-results-in-a-zero-byte-file

    const jsonResponse = await getResponse<any>(
        "delMessages",
        rpcURL,
        devConfig,
        metrics,
    );

    if (jsonResponse.status !== "success") {
        throw new Error(`Voip.ms responded with status ${jsonResponse.status}`);
    }
}

exports.handler = metricScope(
    metrics => async (event: any, context: Context): Promise<void> => {
        log.trace(`Event: ${JSON.stringify(event)}`);

        metrics.putDimensions({ Service: "email-receipt" });

        const devConfig: DevConfig = await getDevConfig();

        if (await lockMailbox(devConfig, context.getRemainingTimeInMillis())) {
            try {
                let voicemailToDownload: VoipMSVoicemail = await getFirstVoicemailDetails(
                    devConfig,
                    metrics,
                );

                while (voicemailToDownload) {
                    log.trace(
                        "Voicemail To Download: " +
                            JSON.stringify(voicemailToDownload, null, 2),
                    );

                    await downloadVoicemail(
                        devConfig,
                        voicemailToDownload,
                        metrics,
                    );

                    if (process.env.SINGLE_VOICEMAIL_DEBUG_MODE === "true") {
                        log.info(
                            "Single Voicemail Debug Mode - not deleting first voicemail and ignoring any others",
                        );
                        voicemailToDownload = null;
                    } else {
                        await deleteVoicemail(
                            devConfig,
                            voicemailToDownload,
                            metrics,
                        );

                        const prevVoicemailDate: string =
                            voicemailToDownload.date;
                        const prevVoicemailCallerid: string =
                            voicemailToDownload.callerid;
                        const prevVoicemailDuration: string =
                            voicemailToDownload.duration;
                        voicemailToDownload = await getFirstVoicemailDetails(
                            devConfig,
                            metrics,
                        );
                        if (
                            voicemailToDownload &&
                            prevVoicemailDate === voicemailToDownload.date &&
                            prevVoicemailCallerid ===
                                voicemailToDownload.callerid &&
                            prevVoicemailDuration ===
                                voicemailToDownload.duration
                        ) {
                            throw new Error(
                                "Error traversing voicemails.  Found the same voicemail twice.",
                            );
                        }
                    }
                }
            } finally {
                await unlockMailbox(devConfig);
            }
        } else {
            log.info("Mailbox was locked by another process.");
        }
    },
);
