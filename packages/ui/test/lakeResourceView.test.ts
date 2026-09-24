import assert from "node:assert/strict";
import test from "node:test";
import type { LakeResource } from "@zcode/services";
import {
  filterLakeResources,
  summarizeLakeResources,
} from "../src/lake-catalog/lakeResourceView.js";

const resources: LakeResource[] = [
  {
    id: "service-1",
    name: "Order API",
    kind: "service",
    environment: "production",
    description: "Handles checkout requests",
    createdAt: 1,
  },
  {
    id: "host-1",
    name: "订单节点",
    kind: "host",
    environment: "staging",
    description: "Shanghai edge machine",
    createdAt: 2,
  },
  {
    id: "database-1",
    name: "Orders PostgreSQL",
    kind: "database",
    environment: "production",
    description: "Primary relational store",
    createdAt: 3,
  },
];

test("resource view combines normalized text, kind and environment filters", () => {
  assert.deepEqual(
    filterLakeResources(resources, {
      query: "  ORDER ",
      kind: "all",
      environment: "production",
    }).map((resource) => resource.id),
    ["service-1", "database-1"],
  );
  assert.deepEqual(
    filterLakeResources(resources, {
      query: "edge",
      kind: "host",
      environment: "all",
    }).map((resource) => resource.id),
    ["host-1"],
  );
  assert.equal(
    filterLakeResources(resources, {
      query: "订单",
      kind: "service",
      environment: "all",
    }).length,
    0,
  );
});

test("resource summary is derived from the current lake snapshot", () => {
  assert.deepEqual(summarizeLakeResources(resources), {
    total: 3,
    byKind: {
      service: 1,
      host: 1,
      "kubernetes-cluster": 0,
      database: 1,
    },
    byEnvironment: {
      production: 2,
      staging: 1,
      development: 0,
      other: 0,
    },
  });
});
