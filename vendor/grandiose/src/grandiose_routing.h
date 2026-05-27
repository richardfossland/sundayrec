/*
**  Copyright (c) 2022 Dr. Ralf S. Engelschall <rse@engelschall.com>
**
**  Licensed under the Apache License, Version 2.0 (the "License");
**  you may not use this file except in compliance with the License.
**  You may obtain a copy of the License at
**
**    http://www.apache.org/licenses/LICENSE-2.0
**
**  Unless required by applicable law or agreed to in writing, software
**  distributed under the License is distributed on an "AS IS" BASIS,
**  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
**  See the License for the specific language governing permissions and
**  limitations under the License.
*/

#ifndef GRANDIOSE_ROUTING_H
#define GRANDIOSE_ROUTING_H

#include "node_api.h"
#include "grandiose_util.h"

napi_value routing(napi_env, napi_callback_info);

struct routingCarrier: carrier {
    char* name = nullptr;
    char* groups = nullptr;
    NDIlib_routing_instance_t routing;
    ~routingCarrier() {
        if (name != nullptr)
            free(name);
        if (groups != nullptr)
            free(groups);
    }
};

#endif /* GRANDIOSE_ROUTING_H */

