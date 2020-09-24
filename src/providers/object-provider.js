import {
    qualifiedNameToId,
    accumulateResults
} from '../utils.js';

import {
    TELEMETRY_OBJECT_TYPE,
    IMAGE_OBJECT_TYPE,
    STRING_OBJECT_TYPE
} from '../const.js';

/*****************************************************************************
 * Open MCT, Copyright (c) 2014-2020, United States Government
 * as represented by the Administrator of the National Aeronautics and Space
 * Administration. All rights reserved.
 *
 * Open MCT is licensed under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * http://www.apache.org/licenses/LICENSE-2.0.
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations
 * under the License.
 *
 * Open MCT includes source code licensed under additional open source
 * licenses. See the Open Source Licenses file (LICENSES.md) included with
 * this source code distribution or the Licensing information page available
 * at runtime from the About dialog for additional information.
 *****************************************************************************/

export default class YamcsObjectProvider {
    constructor(url, instance, folderName) {
        this.url = url;
        this.instance = instance;
        this.folderName = folderName;
        this.dictionary = undefined;
        this.namespace = 'taxonomy';
        this.objects = {};
        this.dictionaryPromise = undefined;

        this.createRootObject();
    }

    createRootObject() {
        this.rootObject = {
            identifier: {
                key: 'spacecraft',
                namespace: this.namespace
            },
            name: this.folderName,
            type: 'folder',
            location: 'ROOT',
            composition: []
        };
        this.addObject(this.rootObject);
    }

    get(identifier) {
        return this.getTelemetryDictionary().then(dictionary => {
            return dictionary[identifier.key];
        });
    }

    getTelemetryDictionary() {
        if (this.dictionary !== undefined) {
            return Promise.resolve(this.dictionary);
        }
        return this.fetchTelemetryDictionary(this.url, this.instance, this.folderName)
            .then((dictionary) => this.dictionary = dictionary);
    }

    fetchTelemetryDictionary() {
        if(this.dictionaryPromise === undefined) {
            let url = this.getMdbUrl('space-systems')
            this.dictionaryPromise = accumulateResults(url, 'spaceSystems', []).then(spaceSystems => {
                return this.fetchMdbApi('parameters?details=yes&limit=1000')
                    .then(parameters => {
                        /* Sort the space systems by name, so that the
                           children of the root object are in sorted order. */
                        spaceSystems.sort((a, b) => {
                            a.name.localeCompare(b.name)
                        })
                        spaceSystems.forEach(spaceSystem => {
                            this.addSpaceSystem(spaceSystem)
                        })
                        if (parameters.parameters) {
                            parameters.parameters.forEach(parameter => {
                                this.addParameterObject(parameter)
                            })
                        }
                        this.dictionaryPromise = undefined;
                        let objects = this.objects;
                        return this.objects;
                    });
            });
        }
        return this.dictionaryPromise;
    }

    getMdbUrl(operation, name='') {
        return this.url + 'api/mdb/' + this.instance + '/' + operation + name
    }

    fetchMdbApi(operation, name='') {
        return fetch(this.url + 'api/mdb/' + this.instance + '/' + operation + name)
            .then(res => {return res.json();});
    }

    addSpaceSystem(spaceSystem) {
        if (spaceSystem.qualifiedName != '/') {
            let composition = []
            if (spaceSystem.sub) {
                /* Sort the subsidiary space systems by name. */
                spaceSystem.sub.sort((a, b) => {
                    return a.name.localeCompare(b.name)
                })
                spaceSystem.sub.forEach(sub => {
                    let subId = qualifiedNameToId(sub.qualifiedName)
                    composition.push({
                        key: subId,
                        namespace: this.namespace
                    })
                })
            }
                        
            let id = qualifiedNameToId(spaceSystem.qualifiedName)
            let obj = {
                identifier: {
                    key: id,
                    namespace: this.namespace
                },
                name: spaceSystem.name,
                type: 'folder',
                composition: composition
            }
            this.addObject(obj)

            /* Add the space system to the root object if it's top-level. */
            if (spaceSystem.qualifiedName.lastIndexOf('/') == 0) {
                this.rootObject.composition.push({
                    key: id,
                    namespace: this.namespace
                })
            }
        }
    }

    addObject(object) {
        this.objects[object.identifier.key] = object;
    }

    /*
     * Add a telemetry parameter object to the object tree, unless it
     * has an alias indicating to omit the parameter from OpenMCT.
     */
    addParameterObject(parameter) {
        if (!this.isSuppressed(parameter)) {
            let qn = parameter.qualifiedName
            let lastSlashPos = qn.lastIndexOf('/')
            let parentId = qualifiedNameToId(qn.substring(0, lastSlashPos))
            let parent = this.objects[parentId]

            this.addParameter(parameter, qn, parent, '')
        }
    }

    isSuppressed(parameter) {
        return (parameter.alias && parameter.alias.some(alias => {
            return (alias.namespace === 'OpenMCT:omit')
        }))
    }

    addParameter(parameter, qualifiedName, parent, prefix) {
        let id = qualifiedNameToId(qualifiedName);
        let name = prefix + parameter.name
        let obj = {
            identifier: {
                key: id,
                namespace: this.namespace
            },
            name: name
        }

        let isAggregate = false;
        if (parameter.type && parameter.type.engType === 'aggregate') {
            isAggregate = true;
        }
        
        if (isAggregate) {
            obj.type = 'folder';
            obj.composition = [];
        } else {
            obj.type = this.getParameterType(parameter);
            obj.telemetry = {
                values: [
                    {
                        key: 'value',
                        name: 'Value',
                        hints: {
                            range: 1
                        }
                    },
                    {
                        key: 'utc',
                        source: 'timestamp',
                        name: 'Timestamp',
                        format: 'iso',
                        hints: {
                            domain: 1
                        }
                    }
                ]
            };

            if (obj.type === STRING_OBJECT_TYPE) {
                obj.telemetry.values[0].hints = {};
            } else if (obj.type === IMAGE_OBJECT_TYPE) {
                obj.telemetry.values[0].hints = { image: 1 };
                obj.telemetry.values[0].format = 'image';
            }
        }

        this.addObject(obj);

        parent.composition.push(obj.identifier);

        if (isAggregate) {
            if (parameter.type.member) {
                parameter.type.member.forEach(member => {
                    let memberQualifiedName = qualifiedName + '.' + member.name;
                    /* Use current name as a prefix for the member name. */
                    this.addParameter(member, memberQualifiedName, obj,
                                      name + '_');
                });
            }
        }
    }

    getParameterType(parameter) {
        for (let i in parameter.alias) {
            if (parameter.alias[i].namespace === 'OpenMCT:type') {
                return parameter.alias[i].name;
            }
        }

        /* Built-in Yamcs telemetry does not supply type information. */
        if (!(parameter.type)) {
            return TELEMETRY_OBJECT_TYPE;
        }
        if (parameter.type.engType === 'integer' || parameter.type.engType === 'float') {
            return TELEMETRY_OBJECT_TYPE;
        }

        return STRING_OBJECT_TYPE;
    }
}
