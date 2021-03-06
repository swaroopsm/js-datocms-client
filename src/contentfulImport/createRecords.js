import ora from 'ora';
import promiseLimit from 'promise-limit';
import Progress from './progress';
import { toItemApiKey, toFieldApiKey } from './toApiKey';

const { camelize } = require('humps');

export default async ({
  itemTypes,
  fieldsMapping,
  datoClient,
  contentfulData,
}) => {
  const spinner = ora('').start();

  try {
    const { entries } = contentfulData;
    const progress = new Progress(entries.length, 'Creating records');

    const contentfulRecordMap = {};
    const recordsToPublish = [];

    spinner.text = progress.tick();

    const limit = promiseLimit(5);
    const jobs = [];

    for (const entry of entries) {
      const { contentType } = entry.sys;
      const contentTypeApiKey = toItemApiKey(contentType.sys.id);

      const itemType = itemTypes.find(iT => {
        return iT.apiKey === contentTypeApiKey;
      });

      const itemTypeFields = fieldsMapping[contentTypeApiKey];

      if (itemType) {
        const emptyFieldValues = itemTypeFields.reduce((accFields, field) => {
          if (field.localized) {
            const value = contentfulData.locales
              .map(locale => locale)
              .reduce(
                (accLocales, locale) =>
                  Object.assign(accLocales, { [locale]: null }),
                {},
              );
            return Object.assign(accFields, {
              [camelize(field.apiKey)]: value,
            });
          }
          return Object.assign(accFields, { [camelize(field.apiKey)]: null });
        }, {});

        const recordAttributes = Object.entries(entry.fields).reduce(
          (acc, [option, value]) => {
            const apiKey = toFieldApiKey(option);
            const field = itemTypeFields.find(f => f.apiKey === apiKey);
            switch (field.fieldType) {
              case 'link':
              case 'links':
              case 'file':
              case 'gallery':
                return acc;
              default:
                break;
            }

            if (field.localized) {
              const localizedValue = Object.keys(value).reduce(
                (innerAcc, locale) => {
                  let innerValue = value[locale];

                  if (field.fieldType === 'lat_lon') {
                    innerValue = {
                      latitude: innerValue.lat,
                      longitude: innerValue.lon,
                    };
                  }

                  if (
                    field.fieldType === 'string' &&
                    Array.isArray(innerValue)
                  ) {
                    innerValue = innerValue.join(', ');
                  }

                  if (field.fieldType === 'json') {
                    innerValue = JSON.stringify(innerValue, null, 2);
                  }
                  return Object.assign(innerAcc, {
                    [locale]: innerValue,
                  });
                },
                {},
              );

              const fallbackValues = contentfulData.locales.reduce(
                (accLocales, locale) => {
                  return Object.assign(accLocales, {
                    [locale]: localizedValue[contentfulData.defaultLocale],
                  });
                },
                {},
              );

              return Object.assign(acc, {
                [camelize(apiKey)]: { ...fallbackValues, ...localizedValue },
              });
            }
            let innerValue = value[contentfulData.defaultLocale];

            if (field.fieldType === 'lat_lon') {
              innerValue = {
                latitude: innerValue.lat,
                longitude: innerValue.lon,
              };
            }

            if (field.fieldType === 'string' && Array.isArray(innerValue)) {
              innerValue = innerValue.join(', ');
            }

            if (field.fieldType === 'json') {
              innerValue = JSON.stringify(innerValue, null, 2);
            }
            return Object.assign(acc, { [camelize(apiKey)]: innerValue });
          },
          emptyFieldValues,
        );

        jobs.push(
          limit(async () => {
            const record = await datoClient.items.create({
              ...recordAttributes,
              itemType: itemType.id.toString(),
            });

            if (entry.sys.publishedVersion) {
              recordsToPublish.push(record.id);
            }

            spinner.text = progress.tick();
            contentfulRecordMap[entry.sys.id] = record.id;
          }),
        );
      }
    }

    await Promise.all(jobs);

    spinner.succeed();

    return { contentfulRecordMap, recordsToPublish };
  } catch (e) {
    spinner.fail();
    throw e;
  }
};
