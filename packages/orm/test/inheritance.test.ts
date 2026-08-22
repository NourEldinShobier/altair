/**
 * Single-table inheritance.
 *
 * Mirrors activerecord/test/cases/inheritance_test.rb. The behaviour worth
 * having is that a query on the root hands back subclass instances — without
 * that, `type` is just a column people remember to check.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { Connection, setConnection } from "../src/connection.js";
import { SchemaStatements } from "../src/schema.js";
import { Model } from "../src/model.js";

interface VehicleAttributes {
  id: number;
  type: string;
  name: string;
  wheels: number;
}

class Vehicle extends Model<VehicleAttributes>("vehicles") {
  describe(): string {
    return `a vehicle called ${String(this.name)}`;
  }
}

class Car extends Vehicle {
  static {
    this.inherit();
  }

  override describe(): string {
    return `a car called ${String(this.name)}`;
  }
}

class Truck extends Vehicle {
  static {
    this.inherit();
  }
}

/** Two levels deep, because Rails' hierarchies are. */
class PickupTruck extends Truck {
  static {
    this.inherit();
  }
}

let connection: Connection;

beforeEach(async () => {
  connection = new Connection("sqlite://:memory:");
  setConnection(connection);

  await new SchemaStatements(connection).createTable("vehicles", (t) => {
    t.string("type");
    t.string("name");
    t.integer("wheels", { default: 4 });
  });
});

describe("declaring a subclass", () => {
  it("shares the root's table", () => {
    expect(Car.table).toBe("vehicles");
    expect(PickupTruck.table).toBe("vehicles");
  });

  it("knows its root", () => {
    expect(Car.stiRoot).toBe(Vehicle);
    expect(PickupTruck.stiRoot).toBe(Vehicle);
  });

  it("registers itself on the root", () => {
    expect(Object.keys(Vehicle.descendants).sort()).toEqual(["Car", "PickupTruck", "Truck"]);
  });
});

describe("writing", () => {
  it("records the class name in the type column", async () => {
    const car = await Car.create({ name: "Beetle" });
    expect(car.type).toBe("Car");
  });

  it("records the root's own name too", async () => {
    const vehicle = await Vehicle.create({ name: "Thing" });
    expect(vehicle.type).toBe("Vehicle");
  });

  it("does not overwrite a type that was given", async () => {
    const vehicle = await Vehicle.create({ name: "Odd", type: "Car" });
    expect(vehicle.type).toBe("Car");
  });
});

describe("reading", () => {
  beforeEach(async () => {
    await Car.create({ name: "Beetle" });
    await Truck.create({ name: "Hauler", wheels: 6 });
    await PickupTruck.create({ name: "Ranger" });
    await Vehicle.create({ name: "Sled", wheels: 0 });
  });

  it("returns everything from the root", async () => {
    expect(await Vehicle.count()).toBe(4);
  });

  // The behaviour STI exists for.
  it("builds each row as the class its type names", async () => {
    const all = await Vehicle.all().order("id");

    expect(all.map((vehicle) => vehicle.constructor.name)).toEqual([
      "Car",
      "Truck",
      "PickupTruck",
      "Vehicle",
    ]);
  });

  it("calls the subclass's own methods", async () => {
    const car = await Vehicle.find(1);
    expect(car.describe()).toBe("a car called Beetle");
  });

  it("limits a subclass to its own rows", async () => {
    expect(await Car.count()).toBe(1);
    expect((await Car.all()).map((car) => car.name)).toEqual(["Beetle"]);
  });

  it("includes a subclass's own subclasses", async () => {
    const trucks = await Truck.all().order("id");
    expect(trucks.map((truck) => truck.name)).toEqual(["Hauler", "Ranger"]);
  });

  it("does not reach sideways across the hierarchy", async () => {
    expect(await PickupTruck.count()).toBe(1);
    expect((await PickupTruck.all())[0]!.name).toBe("Ranger");
  });

  it("filters within a subclass", async () => {
    expect(await Truck.where({ wheels: 6 }).count()).toBe(1);
    expect(await Car.where({ wheels: 6 }).count()).toBe(0);
  });

  it("finds by id within a subclass", async () => {
    expect((await Car.find(1)).name).toBe("Beetle");
    await expect(Car.find(2)).rejects.toThrow();
  });

  // The escape hatch for a query that has to see the whole table.
  it("ignores the type column when unscoped", async () => {
    expect(await Car.unscoped().count()).toBe(4);
  });
});

describe("a model with no hierarchy", () => {
  interface WidgetAttributes {
    id: number;
    name: string;
  }

  class Widget extends Model<WidgetAttributes>("widgets") {}

  // A plain model must not grow a type column just because the feature exists.
  it("writes no type column", async () => {
    await new SchemaStatements(connection).createTable("widgets", (t) => t.string("name"));

    const widget = await Widget.create({ name: "Sprocket" });
    expect((widget as unknown as Record<string, unknown>).type).toBeUndefined();
  });
});
