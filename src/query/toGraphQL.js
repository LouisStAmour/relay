/**
 * Copyright 2013-2015, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule toGraphQL
 * @flow
 */

'use strict';

import type {
  ConcreteField,
  ConcreteFragment,
  ConcreteQuery,
  ConcreteSelection,
} from 'ConcreteQuery';
var QueryBuilder = require('QueryBuilder');
var RelayQuery = require('RelayQuery');

var callsToGraphQL = require('callsToGraphQL');
var invariant = require('invariant');

/**
 * @internal
 *
 * Converts a RelayQuery.Node into a plain object representation. This is
 * equivalent to the AST produced by `babel-relay-plugin` and is intended for
 * use in serializing RelayQuery nodes.
 */
var toGraphQL = {
  Query(node: RelayQuery.Root): ConcreteQuery {
    const batchCall = node.getBatchCall();
    let identifyingArgValue;
    if (batchCall) {
      identifyingArgValue = QueryBuilder.createBatchCallVariable(
        batchCall.sourceQueryID,
        batchCall.sourceQueryPath
      );
    } else {
      const identifyingArg = node.getIdentifyingArg();
      if (identifyingArg) {
        if (Array.isArray(identifyingArg.value)) {
          identifyingArgValue = identifyingArg.value.map(
            QueryBuilder.createCallValue
          );
        } else {
          identifyingArgValue = QueryBuilder.createCallValue(
            identifyingArg.value
          );
        }
      }
    }

    const children = node.getChildren().map(toGraphQLSelection);
    // Use `QueryBuilder` to generate the correct calls from the
    // identifying argument & metadata.
    return QueryBuilder.createQuery({
      children,
      fieldName: node.getFieldName(),
      identifyingArgValue,
      isDeferred: node.isDeferred(),
      metadata: node.getConcreteQueryNode().metadata,
      name: node.getName(),
      type: node.getType(),
    });
  },
  Fragment(node: RelayQuery.Fragment): ConcreteFragment {
    const children = node.getChildren().map(toGraphQLSelection);
    const fragment: ConcreteFragment = {
      children,
      kind: 'Fragment',
      hash: node.getConcreteFragmentHash(),
      metadata: {
        isAbstract: node.isAbstract(),
        plural: node.isPlural(),
      },
      name: node.getDebugName(),
      type: node.getType(),
    };
    return fragment;
  },
  Field(node: RelayQuery.Field): ConcreteField {
    const calls = callsToGraphQL(node.getCallsWithValues());
    const children = node.getChildren().map(toGraphQLSelection);
    const field: ConcreteField = {
      alias: node.getConcreteQueryNode().alias,
      calls,
      children,
      fieldName: node.getSchemaName(),
      kind: 'Field',
      metadata: node.getConcreteQueryNode().metadata,
      type: node.getType(),
    };
    return field;
  },
};

function toGraphQLSelection(
  node: RelayQuery.Node
): ConcreteSelection  {
  if (node instanceof RelayQuery.Fragment) {
    return toGraphQL.Fragment(node);
  } else {
    invariant(node instanceof RelayQuery.Field, 'toGraphQL: Invalid node.');
    return toGraphQL.Field(node);
  }
}

module.exports = toGraphQL;
