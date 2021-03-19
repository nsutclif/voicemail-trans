"use strict";

// This Lambda function gets triggered when AWS Transcribe adds a completed
// transcription to S3.
// Its job is to send a PGP encrypted email containing the transcription 
// and call details.

import { S3Event, S3EventRecord } from "aws-lambda";

import * as AWSRaw from "aws-sdk";
import { captureAWS, captureAsyncFunc } from "aws-xray-sdk-core";
const AWS = captureAWS(AWSRaw);

import * as SES from "aws-sdk/clients/ses";
import * as S3 from "aws-sdk/clients/s3";
import { DocumentClient } from "aws-sdk/lib/dynamodb/document_client";

import * as openpgp from "openpgp"; // The typings that are available don't seem to compile...

const s3: AWS.S3 = new AWS.S3();
const ses: AWS.SES = new AWS.SES();
const documentClient: DocumentClient = new AWSRaw.DynamoDB.DocumentClient();

import * as log from "loglevel";
log.setLevel((process.env.LOG_LEVEL as log.LogLevelDesc) || "info");

interface DevConfig {
    voipMSPassword: string;
    voipMSUser: string;
    voipMSMailbox: string;
    notificationEmail: string[];
    notificationSMS: string[];
}

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

async function getPublicKeyForEmailIfExists(email: string): Promise<string> {
    try {
        const getObjectResult = await s3
            .getObject({
                Bucket: process.env.ConfigurationBucketName,
                Key: `${email}-publickey.asc`,
            })
            .promise();

        return getObjectResult.Body.toString();
    } catch (e) {
        if (e.code === "NoSuchKey") {
            log.trace("No public key found.");
            return "";
        } else {
            throw e;
        }
    }
}

async function encodeMessage(
    messageBody: string,
    recipientPublicKey: string,
): Promise<string> {
    try {
        const pgpOptions: any = {
            message: openpgp.message.fromText(messageBody),
            publicKeys: (await openpgp.key.readArmored(recipientPublicKey))
                .keys,
        };

        let message: any;

        await captureAsyncFunc("openpgp.encrypt", async function(subsegment) {
            message = await openpgp.encrypt(pgpOptions);
            subsegment.close();
        });

        return message.data;
    } catch (e) {
        log.error("Error encrypting message: " + e);
        return "Error encrypting message with provided public key.";
    }
}

async function sendEmailToRecipient(
    voicemailAttributes: DocumentClient.AttributeMap,
    recipient: string,
): Promise<void> {
    const recipientPublicKey: string = await getPublicKeyForEmailIfExists(
        recipient,
    );

    let messageBody: string = voicemailAttributes.transcript;
    if (recipientPublicKey) {
        messageBody = await encodeMessage(messageBody, recipientPublicKey);
    }

    const sendEmailParams: SES.SendEmailRequest = {
        Source: "notification@voippt.com",

        Destination: {
            ToAddresses: [recipient],
        },
        Message: {
            Body: {
                Text: {
                    Data: messageBody,
                },
            },
            Subject: {
                Data: `Voicemail from ${voicemailAttributes.callerid}`,
            },
        },
    };

    log.trace("Sending email: " + JSON.stringify(sendEmailParams, null, 2));

    await ses.sendEmail(sendEmailParams).promise();
}

async function sendEmail(
    voicemailAttributes: DocumentClient.AttributeMap,
): Promise<void> {
    log.trace(
        `voicemailAttributes: ${JSON.stringify(voicemailAttributes, null, 2)}`,
    );

    const devConfig: DevConfig = await getDevConfig();

    await Promise.all(
        devConfig.notificationEmail.map(email => {
            return sendEmailToRecipient(voicemailAttributes, email);
        }),
    );
}

async function processRecord(eventRecord: S3EventRecord): Promise<void> {
    // TODO: Find a more stable way to pass this info through to this function?
    const jobNameParts: string[] = eventRecord.s3.object.key.split("_");
    const tenantid: string = jobNameParts.shift();
    const voicemailidfilename: string = jobNameParts.shift(); // something like 1.mp3
    const voicemailid: string = voicemailidfilename.split(".").shift();

    log.trace(`tenantid: ${tenantid}`);
    log.trace(`voicemailid: ${voicemailid}`);

    const transcriptionS3Object: S3.GetObjectOutput = await s3
        .getObject({
            Bucket: eventRecord.s3.bucket.name,
            Key: eventRecord.s3.object.key,
        })
        .promise();

    const transcriptionResult: any = JSON.parse(
        transcriptionS3Object.Body.toString(),
    );

    log.trace(
        `transcriptionResult: ${JSON.stringify(transcriptionResult, null, 2)}`,
    );

    const updateParams: DocumentClient.UpdateItemInput = {
        TableName: process.env.VOICEMAIL_TABLE_NAME,
        Key: {
            tenantid,
            voicemailid,
        },
        UpdateExpression: "SET transcript = :transcript",
        ExpressionAttributeValues: {
            ":transcript":
                transcriptionResult.results.transcripts[0].transcript,
        },
        ReturnValues: "ALL_NEW",
    };

    log.trace(`updateParams: ${JSON.stringify(updateParams, null, 2)}`);

    const updateResult: DocumentClient.UpdateItemOutput = await documentClient
        .update(updateParams)
        .promise();

    await sendEmail(updateResult.Attributes);
}

exports.handler = async (event: S3Event): Promise<void> => {
    log.trace(`Event: ${JSON.stringify(event)}`);

    // Not sure why there would be mulitple records...
    await Promise.all(event.Records.map(record => processRecord(record)));
};
