import { IsArray, IsBoolean, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

// Corpo do POST /drivers/position (página web da motorista).
// Tem de aceitar tudo o que a página envia (id, name, lat, lng, cats,
// carMake, carPlate, offline) — o ValidationPipe global rejeita extras.
export class PositionDto {
  @IsString()
  @MaxLength(64)
  id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;

  @IsOptional()
  @IsArray()
  cats?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(30)
  carMake?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  carPlate?: string;

  @IsOptional()
  @IsBoolean()
  offline?: boolean;
}
