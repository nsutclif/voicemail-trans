"use strict";

// This Lambda function triggers when a voicemail is added to the S3 bucket.
// Its only job is to write a record of this voicemail to the Index DynamoDB table.

import { S3Event, S3EventRecord } from "aws-lambda";

import * as AWSRaw from "aws-sdk";
import { captureAWS } from "aws-xray-sdk-core";
const AWS = captureAWS(AWSRaw);

import { DocumentClient } from "aws-sdk/lib/dynamodb/document_client";

const s3: AWS.S3 = new AWS.S3();
const documentClient: DocumentClient = new AWSRaw.DynamoDB.DocumentClient();

import * as log from "loglevel";
log.setLevel((process.env.LOG_LEVEL as log.LogLevelDesc) || "info");

async function processRecord(eventRecord: S3EventRecord): Promise<object> {
    const objectMetadata = await s3
        .headObject({
            Bucket: eventRecord.s3.bucket.name,
            Key: eventRecord.s3.object.key,
        })
        .promise();

    // {
    //   "AcceptRanges": "bytes",
    //   "LastModified": "2020-03-07T02:19:51.000Z",
    //   "ContentLength": 81432,
    //   "ETag": "\"e25c27f2856366670b5ea61e13f26394\"",
    //   "ContentType": "application/octet-stream",
    //   "ServerSideEncryption": "AES256",
    //   "Metadata": {
    //      "voicemailid": "asdfasdflskjdflskdjf",
    //     "duration": "00:00:26",
    //     "urgent": "no",
    //     "date": "2020-02-27 09:35:53",
    //     "folder": "INBOX",
    //     "callerid": "CN Sutcliffe <6047553355>",
    //     "mailbox": "279073"
    //   }
    // }

    console.log(`object metadata: ${JSON.stringify(objectMetadata, null, 2)}`);
    //  const putParams: DocumentClient.PutItemInput = {
    //      TableName: process.env.VOICEMAIL_TABLE_NAME,
    //      Item: voicemailToSave,
    //      ConditionExpression: 'attribute_not_exists(TenantIdMailbox)'
    //  };

    const putOutput: DocumentClient.PutItemOutput = await documentClient
        .put({
            TableName: process.env.VOICEMAIL_TABLE_NAME,
            Item: objectMetadata.Metadata,
        })
        .promise();

    log.trace(
        "Result from documentClient.put: " + JSON.stringify(putOutput, null, 2),
    );

    return objectMetadata.Metadata;
}

exports.handler = async (event: S3Event): Promise<object[]> => {
    log.trace(`Event: ${JSON.stringify(event)}`);

    // Return the S3 object metadata fields to be passed to the next Lambda function
    return await Promise.all(
        event.Records.map(record => processRecord(record)),
    );
};
