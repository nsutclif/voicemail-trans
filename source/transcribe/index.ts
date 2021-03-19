"use strict";

// This Lambda function gets triggered when a voicemail is added to the index.
// Its onliy job is to set up and start an asynchronous AWS Transcription job

import { S3EventRecord } from "aws-lambda";

import * as AWSRaw from "aws-sdk";
import { captureAWS } from "aws-xray-sdk-core";
const AWS = captureAWS(AWSRaw);

import * as log from "loglevel";
log.setLevel((process.env.LOG_LEVEL as log.LogLevelDesc) || "info");

import * as Transcribe from "aws-sdk/clients/transcribeservice";

const transcribe: AWS.TranscribeService = new AWS.TranscribeService();

async function processRecord(
    s3Record: S3EventRecord,
    callMetadata: any,
): Promise<void> {
    // const jobName: string = `${eventRecord.s3.object.key}-${new Date().toISOString()}`;
    // Remove the slashes from a key like 279073/INBOX/4.mp3 so it can be used as part of the job name
    // Also remove colons from the time.
    // const sanitizedJobName: string = jobName.replace(/[\/:]/g, "-");

    const jobName = `${callMetadata.tenantid}_${callMetadata.voicemailid}`;

    const params: Transcribe.Types.StartTranscriptionJobRequest = {
        LanguageCode: "en-US",
        Media: {
            MediaFileUri: `https://s3-${s3Record.awsRegion}.amazonaws.com/${s3Record.s3.bucket.name}/${s3Record.s3.object.key}`,
        },
        MediaFormat: "mp3",
        TranscriptionJobName: jobName,
        OutputBucketName: process.env.VOICEMAIL_TRANSCRIPT_BUCKET_NAME,
        // TODO: Set AllowDeferredExecution and DataAccessRoleArn properties here.
        // JobExecutionSettings: {
        //     AllowDeferredExecution: true, // allow jobs to be queued up if we hit a limit
        // }
    };

    log.info(`Starting this job: ${JSON.stringify(params, null, 2)}`);

    await transcribe.startTranscriptionJob(params).promise();
}

// TODO: Define a type for a "destination" event?
exports.handler = async (event: any): Promise<void> => {
    log.trace(`Event: ${JSON.stringify(event)}`);

    // event.requestPayload should be the S3Event passed to the previous function.
    // event.responsePayload should be a corresponding array of results from the previous function.
    if (event.requestPayload.Records.length !== event.responsePayload.length) {
        throw new Error(
            `request payload length doesn't match response payload length`,
        );
    }
    await Promise.all(
        event.requestPayload.Records.map((record, index) =>
            processRecord(record, event.responsePayload[index]),
        ),
    );
};
